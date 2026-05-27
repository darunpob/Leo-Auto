import os
import io
import re
import shutil
import pandas as pd
import json
from fastapi import FastAPI, Form, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from google import genai
from google.genai import types
from PIL import Image

app = FastAPI()

# --- 0. Allow CORS (อนุญาตให้หน้าเว็บ index.html เข้าถึง API ได้) ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- 1. Database Setup ---
DEFAULT_DATA_DIR = "/data" if os.path.isdir("/data") else "."
DATA_DIR = os.getenv("DATA_DIR", DEFAULT_DATA_DIR)
PICTURE_DIR = os.path.join(DATA_DIR, "picture")
DB_FILE = os.path.join(DATA_DIR, "inventory.csv")
ORDERS_FILE = os.path.join(DATA_DIR, "orders.json")
APP_DIR = os.path.dirname(os.path.abspath(__file__))
SEED_DB_FILE = os.path.join(APP_DIR, "inventory.csv")
SEED_ORDERS_FILE = os.path.join(APP_DIR, "orders.json")
SEED_PICTURE_DIR = os.path.join(APP_DIR, "picture")
LOCATION_COLUMN = "Storage Location"
COST_COLUMN = "Cost Price"

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None

# จำลองโฟลเดอร์รูปภาพถ้ายังไม่มี และเปิดให้หน้าเว็บดึงรูปไปแสดงได้
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(PICTURE_DIR, exist_ok=True)

# Seed persistent volume on first run so existing repo data is not lost after enabling /data.
if not os.path.exists(DB_FILE) and os.path.exists(SEED_DB_FILE):
    shutil.copy2(SEED_DB_FILE, DB_FILE)
if not os.path.exists(ORDERS_FILE) and os.path.exists(SEED_ORDERS_FILE):
    shutil.copy2(SEED_ORDERS_FILE, ORDERS_FILE)
if os.path.isdir(SEED_PICTURE_DIR) and not any(os.scandir(PICTURE_DIR)):
    for name in os.listdir(SEED_PICTURE_DIR):
        src = os.path.join(SEED_PICTURE_DIR, name)
        dst = os.path.join(PICTURE_DIR, name)
        if os.path.isfile(src) and not os.path.exists(dst):
            shutil.copy2(src, dst)

app.mount("/picture", StaticFiles(directory=PICTURE_DIR), name="picture")

@app.get("/")
async def root():
    frontend_path = os.path.join(APP_DIR, "frontend", "index.html")
    if os.path.exists(frontend_path):
        return FileResponse(frontend_path, media_type="text/html")
    return {"status": "ok", "service": "leo-auto-backend"}

@app.get("/health")
async def health():
    return {"status": "healthy"}

# ฟังก์ชันจัดการ CSV
def get_db():
    if not os.path.exists(DB_FILE):
        return pd.DataFrame(columns=["Part Number", "Part Name", "Brand", "Series", "Price", "Stock", "Used_Price", "Used_Stock", "Image_URL", LOCATION_COLUMN, COST_COLUMN])

    df = pd.read_csv(DB_FILE, encoding='utf-8-sig').fillna("")
    df['Part Number'] = df['Part Number'].astype(str)

    # helper: normalize filename matching (handles extra spaces before .png)
    def _norm(s: str) -> str:
        s = (s or "").strip()
        s = " ".join(s.split())  # collapse whitespace
        s = s.replace(" .", ".")  # "xxx .png" -> "xxx.png"
        return s

    # Build a lookup of available images once
    picture_files = []
    try:
        picture_files = os.listdir(PICTURE_DIR)
    except Exception:
        picture_files = []

    # Pre-normalize for fuzzy match
    normalized_to_file = {}
    for fn in picture_files:
        if not fn.lower().endswith(".png"):
            continue
        normalized_to_file[_norm(fn)] = fn

    def _find_best_image(part_number: str) -> str:
        # attempt 1: exact normalized part number match
        p = _norm(part_number)
        candidates = []
        # Our real filename example: "FDH02032L-Y FDH02032R-Y .png"
        # after norm => "FDH02032L-Y FDH02032R-Y.png"
        direct = normalized_to_file.get(f"{p}.png")
        if direct:
            return f"picture/{direct}"

        # attempt 2: partial contains (handles L-only vs combined L/R)
        # choose the longest filename that contains the normalized part_number tokens
        best = None
        best_len = -1
        for norm_name, raw_fn in normalized_to_file.items():
            base = norm_name[:-4]  # remove ".png"
            if p and p in base:
                if len(base) > best_len:
                    best_len = len(base)
                    best = raw_fn

        if best:
            return f"picture/{best}"

        return ""

    # Ensure cost column exists
    if COST_COLUMN not in df.columns:
        df[COST_COLUMN] = 0
    # Ensure L/R stock columns exist
    if "Stock_LH" not in df.columns:
        df["Stock_LH"] = 0
    if "Stock_RH" not in df.columns:
        df["Stock_RH"] = 0

    # If Image_URL is empty, try to fill from picture folder
    if "Image_URL" in df.columns:
        mask_missing = (df["Image_URL"].astype(str).str.strip() == "") | (df["Image_URL"].astype(str).str.lower() == "nan")
        if mask_missing.any():
            for idx in df.index[mask_missing]:
                pn = str(df.at[idx, "Part Number"])
                filled = _find_best_image(pn)
                if filled:
                    df.at[idx, "Image_URL"] = filled
    else:
        df["Image_URL"] = ""

    return df

def save_db(df):
    df.to_csv(DB_FILE, index=False)

# ==========================================
# 🛠️ 2. API สำหรับจัดการสต็อก (CRUD Operations)
# ==========================================

# [READ] โหลดข้อมูลสินค้าทั้งหมด
@app.get("/api/inventory")
async def get_inventory():
    df = get_db()
    return df.to_dict(orient="records")

# [CREATE] เพิ่มสินค้าใหม่
@app.post("/api/inventory")
async def add_product(
    part_number: str = Form(...),
    part_name: str = Form(...),
    brand: str = Form(...),
    series: str = Form(...),
    price: float = Form(...),
    stock: int = Form(...),
    used_price: float = Form(0),
    used_stock: int = Form(0),
    cost_price: float = Form(0),
    location: str = Form(""),
    stock_lh: str = Form("0"),
    stock_rh: str = Form("0"),
    images: list[UploadFile] = File([])
):
    def _to_int(v, default=0):
        try: return int(str(v).strip()) if str(v).strip() else default
        except: return default
    stock_lh_val = _to_int(stock_lh)
    stock_rh_val = _to_int(stock_rh)
    df = get_db()
    if part_number in df['Part Number'].values:
        raise HTTPException(status_code=400, detail="Part Number นี้มีอยู่แล้วในระบบ!")
    
    image_urls = []
    # Sanitize part_number for use in filenames (replace / and other unsafe chars)
    safe_pn = re.sub(r'[/\\:*?"<>|]', '_', part_number).strip()
    if images:
        for i, image in enumerate(images):
            if image.filename:
                ext = image.filename.split(".")[-1].lower()
                # สร้างชื่อไฟล์ที่ไม่ซ้ำกัน
                safe_filename = f"{safe_pn}_{i+1}.{ext}"
                file_path = os.path.join(PICTURE_DIR, safe_filename)
                with open(file_path, "wb") as buffer:
                    shutil.copyfileobj(image.file, buffer)
                image_urls.append(f"picture/{safe_filename}")
            
    new_data = {
        "Part Number": part_number,
        "Part Name": part_name,
        "Brand": brand.strip().upper(),
        "Series": series.strip().upper(),
        "Price": price,
        "Stock": stock,
        "Used_Price": used_price,
        "Used_Stock": used_stock,
        "Image_URL": ",".join(image_urls),
        LOCATION_COLUMN: location,
        COST_COLUMN: cost_price,
        "Stock_LH": stock_lh_val,
        "Stock_RH": stock_rh_val
    }
    df = pd.concat([df, pd.DataFrame([new_data])], ignore_index=True)
    save_db(df)
    return {"message": "✅ เพิ่มสินค้าสำเร็จ!", "image_url": ",".join(image_urls)}

# [UPDATE] แก้ไขสินค้าเดิม
@app.put("/api/inventory")
async def update_product(
    part_number: str = Form(...),
    part_name: str = Form(...),
    brand: str = Form(...),
    series: str = Form(...),
    price: float = Form(...),
    stock: int = Form(...),
    used_price: float = Form(0),
    used_stock: int = Form(0),
    cost_price: float = Form(0),
    location: str = Form(""),
    stock_lh: str = Form("0"),
    stock_rh: str = Form("0"),
    images: list[UploadFile] = File([])
):
    def _to_int(v, default=0):
        try: return int(str(v).strip()) if str(v).strip() else default
        except: return default
    stock_lh_val = _to_int(stock_lh)
    stock_rh_val = _to_int(stock_rh)
    part_number = part_number.strip()
    df = get_db()
    df['Part Number'] = df['Part Number'].astype(str).str.strip()
    if part_number not in df['Part Number'].values:
        raise HTTPException(status_code=404, detail="ไม่พบสินค้าในระบบ")
    
    idx = df[df['Part Number'] == part_number].index[0]
    
    # อัปเดตข้อมูลทั่วไป
    df.at[idx, "Part Name"] = part_name
    df.at[idx, "Brand"] = brand.strip().upper()
    df.at[idx, "Series"] = series.strip().upper()
    df.at[idx, "Price"] = price
    df.at[idx, "Stock"] = stock
    df.at[idx, "Used_Price"] = used_price
    df.at[idx, "Used_Stock"] = used_stock
    df.at[idx, LOCATION_COLUMN] = location
    df.at[idx, COST_COLUMN] = cost_price
    df.at[idx, "Stock_LH"] = stock_lh_val
    df.at[idx, "Stock_RH"] = stock_rh_val

    # จัดการรูปภาพ
    existing_urls = df.at[idx, "Image_URL"]
    if pd.isna(existing_urls) or not existing_urls:
        existing_urls = ""
        
    image_urls = existing_urls.split(',') if existing_urls else []

    # Sanitize part_number for use in filenames (replace / and other unsafe chars)
    safe_pn = re.sub(r'[/\\:*?"<>|]', '_', part_number).strip()
    if images:
        # หาเลข index สูงสุดของรูปที่มีอยู่เพื่อตั้งชื่อไฟล์ใหม่
        max_index = 0
        for url in image_urls:
            try:
                # ดึงเลข index จากชื่อไฟล์ เช่น 'PN_1.jpg' -> 1
                filename = url.split('/')[-1]
                index_part = filename.split('_')[-1].split('.')[0]
                if index_part.isdigit():
                    max_index = max(max_index, int(index_part))
            except:
                continue

        for i, image in enumerate(images):
            if image.filename:
                ext = image.filename.split(".")[-1].lower()
                # สร้างชื่อไฟล์ใหม่ต่อจาก index เดิม
                safe_filename = f"{safe_pn}_{max_index + i + 1}.{ext}"
                file_path = os.path.join(PICTURE_DIR, safe_filename)
                with open(file_path, "wb") as buffer:
                    shutil.copyfileobj(image.file, buffer)
                image_urls.append(f"picture/{safe_filename}")
    
    # ลบรายการ URL ที่ว่างเปล่าออก
    image_urls = [url for url in image_urls if url]
    df.at[idx, "Image_URL"] = ",".join(image_urls)
        
    save_db(df)
    return {"message": f"✅ อัปเดต {part_number} สำเร็จ!", "image_url": ",".join(image_urls)}

# [DELETE] ลบสินค้า
@app.delete("/api/inventory")
async def delete_product(part_number: str):
    part_number = part_number.strip()
    df = get_db()
    df['Part Number'] = df['Part Number'].astype(str).str.strip()
    if part_number not in df['Part Number'].values:
        raise HTTPException(status_code=404, detail="ไม่พบสินค้าในระบบ")
    
    # ลบรูปภาพที่เกี่ยวข้องก่อน
    idx = df[df['Part Number'] == part_number].index[0]
    image_urls_str = df.at[idx, "Image_URL"]
    if pd.notna(image_urls_str) and image_urls_str:
        image_urls = image_urls_str.split(',')
        for url in image_urls:
            rel_url = str(url).replace("\\", "/").lstrip("/")
            if rel_url.startswith("picture/"):
                rel_url = rel_url[len("picture/"):]
            file_path = os.path.join(PICTURE_DIR, rel_url)
            if os.path.exists(file_path):
                os.remove(file_path)

    df = df[df['Part Number'] != part_number]
    save_db(df)
    return {"message": f"🗑️ ลบ {part_number} สำเร็จ!"}


# [DELETE IMAGE] ลบรูปภาพเดียว
@app.delete("/api/inventory/image")
async def delete_image(part_number: str, image_url: str):
    df = get_db()
    if part_number not in df['Part Number'].values:
        raise HTTPException(status_code=404, detail="ไม่พบสินค้าในระบบ")

    idx = df[df['Part Number'] == part_number].index[0]
    
    # ดึงรายการ URL ที่มีอยู่
    existing_urls_str = df.at[idx, "Image_URL"]
    if pd.isna(existing_urls_str) or not existing_urls_str:
        raise HTTPException(status_code=404, detail="ไม่พบรูปภาพสำหรับสินค้านี้")

    image_urls = existing_urls_str.split(',')
    
    # ตรวจสอบว่า URL ที่จะลบมีอยู่จริงหรือไม่
    if image_url not in image_urls:
        raise HTTPException(status_code=404, detail="ไม่พบ URL รูปภาพที่ระบุ")

    # ลบไฟล์รูปภาพออกจาก physical storage
    rel_url = str(image_url).replace("\\", "/").lstrip("/")
    if rel_url.startswith("picture/"):
        rel_url = rel_url[len("picture/"):]
    file_path = os.path.join(PICTURE_DIR, rel_url)
    if os.path.exists(file_path):
        os.remove(file_path)
    
    # ลบ URL ออกจากรายการและอัปเดต DataFrame
    image_urls.remove(image_url)
    df.at[idx, "Image_URL"] = ",".join(image_urls)
    
    save_db(df)
    return {"message": f"🗑️ ลบรูปภาพ {image_url} สำเร็จ!"}




# ==========================================
# 🤖 3. API สำหรับ AI (Gemini 2.5 Flash)
# ==========================================

# [AI CHAT] แชทบอตสอบถามสต็อก
@app.post("/api/chat")
async def ai_chat(question: str = Form(...)):
    if client is None:
        raise HTTPException(status_code=503, detail="GEMINI_API_KEY is not configured")
    df = get_db()
    inventory_csv = df.to_csv(index=False)
    
    prompt = f"""
    You are an expert sales representative for the 'Leo Auto' truck parts store. 
    Look at the inventory data (CSV):
    {inventory_csv}
    
    Customer question: "{question}"
    
    Conditions:
    1. Check if the item is in stock. If yes, provide the name, price, and stock quantity.
    2. Keep the answer short, concise, and friendly. Answer in Thai.
    """
    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash", 
            contents=prompt
        )
        return {"reply": response.text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# [AI VISION] สแกนรูปภาพหา Part Number
@app.post("/api/vision")
async def ai_vision(file: UploadFile = File(...)):
    if client is None:
        raise HTTPException(status_code=503, detail="GEMINI_API_KEY is not configured")
    import re
    df = get_db()
    try:
        contents = await file.read()

        # Detect mime type
        mime = file.content_type or "image/jpeg"
        if not mime or "octet" in mime:
            ext = (file.filename or "").lower().rsplit(".", 1)[-1]
            mime = {"png": "image/png", "jpg": "image/jpeg",
                    "jpeg": "image/jpeg", "webp": "image/webp",
                    "gif": "image/gif"}.get(ext, "image/jpeg")

        part_numbers = df['Part Number'].tolist()
        part_names   = df['Part Name'].tolist()
        image_part   = types.Part.from_bytes(data=contents, mime_type=mime)

        # ── CALL 1: identify the part type from the image ──
        identify_prompt = (
            "You are a truck parts expert. Look at this image and respond with "
            "ONLY a 1-line description of what type of truck part it is. "
            "Example: 'steering wheel' or 'air filter' or 'door mirror bracket'. "
            "No extra text."
        )
        id_resp = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[identify_prompt, image_part]
        )
        part_type = id_resp.text.strip().split('\n')[0].strip()

        # ── CALL 2: match against inventory with the part type hint ──
        parts_info = "\n".join(
            f"{pn}: {name}"
            for pn, name in zip(part_numbers, part_names)
        )
        match_prompt = (
            f"The truck part in the image has been identified as: {part_type}\n\n"
            f"Below is our inventory (Part Number: Part Name):\n{parts_info}\n\n"
            f"Rules:\n"
            f"1. Pick the ONE Part Number whose name best matches '{part_type}'.\n"
            f"2. Your entire response must be EXACTLY the Part Number — nothing else.\n"
            f"3. No explanation, no sentence, no markdown, no prefix.\n"
            f"4. If no match exists, respond with exactly: None\n\n"
            f"Part Number:"
        )
        match_resp = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[match_prompt, image_part]
        )
        raw = match_resp.text.strip()

        # ── Matching: normalize whitespace for robust PN comparison ──
        def _norm(s: str) -> str:
            return ' '.join(s.strip().split()).upper()

        # Build lookup: normalized PN → original PN
        norm_pn_map = {_norm(p): p.strip() for p in part_numbers}

        result = None
        # Pass 1: exact normalized match line-by-line
        for line in raw.split('\n'):
            candidate = line.strip().strip('`').strip('*').strip()
            if _norm(candidate) in norm_pn_map:
                result = norm_pn_map[_norm(candidate)]
                break

        # Pass 2: regex tokens → normalized match
        if not result:
            tokens = re.findall(r'[A-Z0-9]{2,}(?:[-\s][A-Z0-9]+)*', raw.upper())
            for tok in tokens:
                if tok in norm_pn_map:
                    result = norm_pn_map[tok]
                    break

        # Pass 3: keyword fallback — find part names that contain words from part_type
        stop = {'a','an','the','for','is','of','in','on','at','with','and','or','to'}
        pt_words = [w for w in re.sub(r'[^\w\s]','',part_type.lower()).split()
                    if len(w) >= 4 and w not in stop]
        keyword_matches = []
        if pt_words:
            for pn, name in zip(part_numbers, part_names):
                name_l = name.lower()
                if sum(1 for w in pt_words if w in name_l) >= max(1, len(pt_words)//2):
                    keyword_matches.append(pn.strip())
            keyword_matches = keyword_matches[:6]

        if result and result.lower() != "none":
            return {"match": result, "identified_as": part_type}
        elif keyword_matches:
            return {
                "match": None,
                "identified_as": part_type,
                "candidates": keyword_matches,
                "message": f"AI ระบุว่าเป็น '{part_type}' — พบสินค้าใกล้เคียง {len(keyword_matches)} รายการ"
            }
        else:
            return {"match": None, "identified_as": part_type, "message": f"AI ระบุว่าเป็น '{part_type}' แต่ไม่พบในฐานข้อมูล"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

import json
# --- Helper Functions ---
def _load_orders():
    if not os.path.exists(ORDERS_FILE):
        return []
    try:
        with open(ORDERS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, FileNotFoundError):
        return []

def _save_orders(data):
    with open(ORDERS_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=4)

def _compute_bill_total(items):
    return sum(it.get("quantity", 0) * it.get("unit_price", 0) for it in items)

def _normalize_payment_method(value):
    return "cash" if str(value or "").strip().lower() == "cash" else "transfer"

def _normalize_order_items(items, inventory_df=None):
    if not isinstance(items, list) or not items:
        raise HTTPException(status_code=422, detail="items must be a non-empty array")

    norm_items = []
    for it in items:
        pn = str(it.get("part_number", "")).strip()
        qty = it.get("quantity")
        unit = it.get("unit_price")
        item_type = str(it.get("type", "new") or "new")
        custom_name = str(it.get("part_name", "")).strip()

        if not pn:
            raise HTTPException(status_code=422, detail="Missing item.part_number")
        try:
            qty_f = float(qty)
        except (ValueError, TypeError):
            raise HTTPException(status_code=422, detail="Invalid item.quantity")
        try:
            unit_f = float(unit)
        except (ValueError, TypeError):
            raise HTTPException(status_code=422, detail="Invalid item.unit_price")
        if qty_f <= 0:
            raise HTTPException(status_code=422, detail="item.quantity must be > 0")
        if unit_f < 0:
            raise HTTPException(status_code=422, detail="item.unit_price must be >= 0")

        part_name = custom_name
        if inventory_df is not None and not part_name:
            part_name_series = inventory_df.loc[inventory_df['Part Number'] == pn, 'Part Name']
            part_name = part_name_series.iloc[0] if not part_name_series.empty else ""

        norm_items.append({
            "part_number": pn,
            "quantity": int(qty_f) if qty_f == int(qty_f) else qty_f,
            "unit_price": unit_f,
            "part_name": part_name,
            "type": item_type,
            "payment_method": _normalize_payment_method(it.get("payment_method"))
        })

    return norm_items


# [CREATE] บันทึกบิลขายรายวัน (รับ JSON)
@app.post("/api/orders")
async def create_order(data: dict):
    date = data.get("date")
    items = data.get("items", [])
    bill_name = data.get("name", "") # รับชื่อบิล

    if not date:
        raise HTTPException(status_code=422, detail="Missing field: date")
    if not isinstance(items, list) or not items:
        raise HTTPException(status_code=422, detail="items must be a non-empty array")

    # --- Stock Deduction Logic ---
    inventory_df = get_db()
    inventory_df['Part Number'] = inventory_df['Part Number'].astype(str)
    
    for it in items:
        pn = str(it.get("part_number"))
        qty = float(it.get("quantity", 0))
        item_type = it.get("type", "new") # default to 'new' if not provided

        mask = inventory_df['Part Number'] == pn
        if not mask.any():
            raise HTTPException(status_code=404, detail=f"Part number {pn} not found in inventory")
        
        idx = inventory_df.index[mask][0]

        if item_type == 'used':
            stock_col = 'Used_Stock'
        else: # 'new'
            stock_col = 'Stock'

        current_stock = pd.to_numeric(inventory_df.at[idx, stock_col], errors='coerce')
        if pd.isna(current_stock):
            current_stock = 0

        if current_stock < qty:
            raise HTTPException(status_code=400, detail=f"Not enough stock for {pn} ({item_type}). Have: {current_stock}, Need: {qty}")
        
        inventory_df.at[idx, stock_col] = current_stock - qty

    # --- End Stock Deduction ---
    save_db(inventory_df) # <--- ⭐️ บันทึกไฟล์ CSV ที่อัปเดตสต็อกแล้ว

    norm_items = _normalize_order_items(items, inventory_df)

    bills = _load_orders()
    next_no = 1
    if bills:
        try:
            # Find the max bill_no and add 1
            max_no = max(b.get("bill_no", 0) for b in bills)
            next_no = max_no + 1
        except (ValueError, TypeError):
            next_no = len(bills) + 1
    
    new_bill = {
        "bill_no": next_no,
        "name": bill_name or f"บิล #{next_no}", # ใช้ชื่อที่ส่งมา หรือตั้งชื่อ default
        "date": date,
        "items": norm_items,
        "total": _compute_bill_total(norm_items)
    }
    bills.append(new_bill)
    _save_orders(bills)
    
    return {"message": f"บันทึกบิล #{next_no} สำเร็จ!", "new_bill": new_bill}

# [READ] โหลดบิลทั้งหมด
@app.get("/api/orders")
async def get_orders():
    bills = _load_orders()
    # เรียงจากใหม่ไปเก่า
    return sorted(bills, key=lambda b: b.get("bill_no", 0), reverse=True)

# [UPDATE] แก้ไขชื่อบิล
@app.put("/api/orders/{bill_no}")
async def update_order_name(bill_no: int, data: dict):
    new_name = data.get("name")
    if not new_name:
        raise HTTPException(status_code=422, detail="Missing field: name")

    bills = _load_orders()
    bill_found = False
    for bill in bills:
        if bill.get("bill_no") == bill_no:
            bill["name"] = new_name
            bill_found = True
            break
    
    if not bill_found:
        raise HTTPException(status_code=404, detail=f"Bill #{bill_no} not found")

    _save_orders(bills)
    return {"message": f"อัปเดตชื่อบิล #{bill_no} เป็น '{new_name}' สำเร็จ"}

# [DELETE] ลบบิล
@app.delete("/api/orders/{bill_no}")
async def delete_order(bill_no: int):
    bills = _load_orders()
    original_len = len(bills)
    
    bills_to_keep = [b for b in bills if b.get("bill_no") != bill_no]

    if len(bills_to_keep) == original_len:
        raise HTTPException(status_code=404, detail=f"Bill #{bill_no} not found")

    _save_orders(bills_to_keep)
    return {"message": f"ลบบิล #{bill_no} สำเร็จ"}
    
    bills_to_keep = [b for b in bills if b.get("bill_no") != bill_no]

    if len(bills_to_keep) == original_len:
        raise HTTPException(status_code=404, detail=f"Bill #{bill_no} not found")

    _save_orders(bills_to_keep)
    return {"message": f"ลบบิล #{bill_no} สำเร็จ"}

@app.put("/api/orders/{bill_no}/detail")
async def update_order_detail(bill_no: int, data: dict):
    bills = _load_orders()
    updated_bill = None
    for bill in bills:
        if bill.get("bill_no") == bill_no:
            new_name = str(data.get("name") or "").strip()
            if new_name:
                bill["name"] = new_name
            if "items" in data:
                bill["items"] = _normalize_order_items(data.get("items", []))
                bill["total"] = _compute_bill_total(bill["items"])
            updated_bill = bill
            break

    if updated_bill is None:
        raise HTTPException(status_code=404, detail=f"Bill #{bill_no} not found")

    _save_orders(bills)
    return {"message": f"อัปเดตรายละเอียดบิล #{bill_no} สำเร็จ", "bill": updated_bill}

if __name__ == "__main__":
    import uvicorn
    # สั่งรัน Server ที่พอร์ต 8000
    uvicorn.run(app, host="0.0.0.0", port=8000)
