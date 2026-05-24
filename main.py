import os
import io
import shutil
import pandas as pd
import json
from fastapi import FastAPI, Form, UploadFile, File, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types
from PIL import Image
from sqlalchemy.orm import Session
from sqlalchemy import select
from database import init_db, SessionLocal, InventoryItem, Order
from dotenv import load_dotenv
from datetime import datetime

load_dotenv()

app = FastAPI()

# Initialize database tables
init_db()

# --- 0. Allow CORS ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- 1. AI & Database Setup ---
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "AIzaSyA4OMdkw35WXwVUbyLahn57BRbjyng0xlQ")
client = genai.Client(api_key=GOOGLE_API_KEY)

# Picture folder
if not os.path.exists("picture"):
    os.makedirs("picture")
app.mount("/picture", StaticFiles(directory="picture"), name="picture")

# Dependency for DB session
def get_db_session():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ==========================================
# 🛠️ 2. API สำหรับจัดการสต็อก (CRUD Operations)
# ==========================================

# [READ] โหลดข้อมูลสินค้าทั้งหมด
@app.get("/api/inventory")
async def get_inventory(db: Session = Depends(get_db_session)):
    items = db.query(InventoryItem).all()
    return [
        {
            "Part Number": item.part_number,
            "Part Name": item.part_name,
            "Brand": item.brand,
            "Series": item.series,
            "Price": item.price,
            "Stock": item.stock,
            "Used_Price": item.used_price,
            "Used_Stock": item.used_stock,
            "Image_URL": item.image_url,
            "Storage Location": item.storage_location,
            "Cost Price": item.cost_price,
        }
        for item in items
    ]

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
    images: list[UploadFile] = File([]),
    db: Session = Depends(get_db_session),
):
    # Check if part_number already exists
    existing = db.query(InventoryItem).filter(InventoryItem.part_number == part_number).first()
    if existing:
        raise HTTPException(status_code=400, detail="Part Number นี้มีอยู่แล้วในระบบ!")
    
    image_urls = []
    if images:
        for i, image in enumerate(images):
            if image.filename:
                ext = image.filename.split(".")[-1]
                safe_filename = f"{part_number}_{i+1}.{ext}"
                file_path = f"picture/{safe_filename}"
                with open(file_path, "wb") as buffer:
                    shutil.copyfileobj(image.file, buffer)
                image_urls.append(file_path)
    
    new_item = InventoryItem(
        part_number=part_number,
        part_name=part_name,
        brand=brand,
        series=series,
        price=price,
        stock=stock,
        used_price=used_price,
        used_stock=used_stock,
        image_url=",".join(image_urls),
        storage_location=location,
        cost_price=cost_price,
    )
    db.add(new_item)
    db.commit()
    return {"message": "✅ เพิ่มสินค้าสำเร็จ!"}

# [UPDATE] แก้ไขสินค้าเดิม
@app.put("/api/inventory/{part_number}")
async def update_product(
    part_number: str,
    part_name: str = Form(...),
    brand: str = Form(...),
    series: str = Form(...),
    price: float = Form(...),
    stock: int = Form(...),
    used_price: float = Form(0),
    used_stock: int = Form(0),
    cost_price: float = Form(0),
    location: str = Form(""),
    images: list[UploadFile] = File([]),
    db: Session = Depends(get_db_session),
):
    item = db.query(InventoryItem).filter(InventoryItem.part_number == part_number).first()
    if not item:
        raise HTTPException(status_code=404, detail="ไม่พบสินค้าในระบบ")
    
    # Update fields
    item.part_name = part_name
    item.brand = brand
    item.series = series
    item.price = price
    item.stock = stock
    item.used_price = used_price
    item.used_stock = used_stock
    item.storage_location = location
    item.cost_price = cost_price
    item.updated_at = datetime.utcnow()
    
    # Handle images
    existing_urls = item.image_url.split(',') if item.image_url else []
    
    if images:
        max_index = 0
        for url in existing_urls:
            try:
                filename = url.split('/')[-1]
                index_part = filename.split('_')[-1].split('.')[0]
                if index_part.isdigit():
                    max_index = max(max_index, int(index_part))
            except:
                continue
        
        for i, image in enumerate(images):
            if image.filename:
                ext = image.filename.split(".")[-1]
                safe_filename = f"{part_number}_{max_index + i + 1}.{ext}"
                file_path = f"picture/{safe_filename}"
                with open(file_path, "wb") as buffer:
                    shutil.copyfileobj(image.file, buffer)
                existing_urls.append(file_path)
    
    existing_urls = [url for url in existing_urls if url]
    item.image_url = ",".join(existing_urls)
    
    db.commit()
    return {"message": f"✅ อัปเดต {part_number} สำเร็จ!"}

# [DELETE] ลบสินค้า
@app.delete("/api/inventory/{part_number}")
async def delete_product(part_number: str, db: Session = Depends(get_db_session)):
    item = db.query(InventoryItem).filter(InventoryItem.part_number == part_number).first()
    if not item:
        raise HTTPException(status_code=404, detail="ไม่พบสินค้าในระบบ")
    
    # Delete associated images
    if item.image_url:
        image_urls = item.image_url.split(',')
        for url in image_urls:
            if os.path.exists(url):
                os.remove(url)
    
    db.delete(item)
    db.commit()
    return {"message": f"🗑️ ลบ {part_number} สำเร็จ!"}

# [DELETE IMAGE] ลบรูปภาพเดียว
@app.delete("/api/inventory/{part_number}/image")
async def delete_image(part_number: str, image_url: str, db: Session = Depends(get_db_session)):
    item = db.query(InventoryItem).filter(InventoryItem.part_number == part_number).first()
    if not item:
        raise HTTPException(status_code=404, detail="ไม่พบสินค้าในระบบ")
    
    if not item.image_url:
        raise HTTPException(status_code=404, detail="ไม่พบรูปภาพสำหรับสินค้านี้")
    
    image_urls = item.image_url.split(',')
    if image_url not in image_urls:
        raise HTTPException(status_code=404, detail="ไม่พบ URL รูปภาพที่ระบุ")
    
    if os.path.exists(image_url):
        os.remove(image_url)
    
    image_urls.remove(image_url)
    item.image_url = ",".join(image_urls)
    db.commit()
    return {"message": f"🗑️ ลบรูปภาพ {image_url} สำเร็จ!"}


# ==========================================
# 🤖 3. API สำหรับ AI (Gemini)
# ==========================================

# [AI CHAT] แชทบอตสอบถามสต็อก
@app.post("/api/chat")
async def ai_chat(question: str = Form(...), db: Session = Depends(get_db_session)):
    items = db.query(InventoryItem).all()
    
    # Convert to CSV format for AI
    data = [
        {
            "Part Number": item.part_number,
            "Part Name": item.part_name,
            "Brand": item.brand,
            "Series": item.series,
            "Price": item.price,
            "Stock": item.stock,
            "Used_Price": item.used_price,
            "Used_Stock": item.used_stock,
        }
        for item in items
    ]
    
    df = pd.DataFrame(data)
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
async def ai_vision(file: UploadFile = File(...), db: Session = Depends(get_db_session)):
    import re
    items = db.query(InventoryItem).all()
    part_numbers = [item.part_number for item in items]
    part_names = [item.part_name for item in items]
    
    try:
        contents = await file.read()
        mime = file.content_type or "image/jpeg"
        if not mime or "octet" in mime:
            ext = (file.filename or "").lower().rsplit(".", 1)[-1]
            mime = {"png": "image/png", "jpg": "image/jpeg",
                    "jpeg": "image/jpeg", "webp": "image/webp",
                    "gif": "image/gif"}.get(ext, "image/jpeg")

        image_part = types.Part.from_bytes(data=contents, mime_type=mime)

        # Identify part type
        identify_prompt = (
            "You are a truck parts expert. Look at this image and respond with "
            "ONLY a 1-line description of what type of truck part it is. "
            "No extra text."
        )
        id_resp = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[identify_prompt, image_part]
        )
        part_type = id_resp.text.strip().split('\n')[0].strip()

        # Match against inventory
        parts_info = "\n".join(f"{pn}: {name}" for pn, name in zip(part_numbers, part_names))
        match_prompt = (
            f"The truck part in the image has been identified as: {part_type}\n\n"
            f"Below is our inventory (Part Number: Part Name):\n{parts_info}\n\n"
            f"Rules:\n"
            f"1. Pick the ONE Part Number whose name best matches '{part_type}'.\n"
            f"2. Your entire response must be EXACTLY the Part Number — nothing else.\n"
            f"3. No explanation, no sentence, no markdown.\n"
            f"4. If no match, respond with: None\n\nPart Number:"
        )
        match_resp = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[match_prompt, image_part]
        )
        raw = match_resp.text.strip()

        def _norm(s: str) -> str:
            return ' '.join(s.strip().split()).upper()

        norm_pn_map = {_norm(p): p.strip() for p in part_numbers}
        result = None
        
        for line in raw.split('\n'):
            candidate = line.strip().strip('`').strip('*').strip()
            if _norm(candidate) in norm_pn_map:
                result = norm_pn_map[_norm(candidate)]
                break

        if not result:
            tokens = re.findall(r'[A-Z0-9]{2,}(?:[-\s][A-Z0-9]+)*', raw.upper())
            for tok in tokens:
                if tok in norm_pn_map:
                    result = norm_pn_map[tok]
                    break

        if result and result.lower() != "none":
            return {"match": result, "identified_as": part_type}
        else:
            return {"match": None, "identified_as": part_type, "message": f"AI ระบุว่าเป็น '{part_type}' แต่ไม่พบในฐานข้อมูล"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==========================================
# 📋 4. API สำหรับ Orders
# ==========================================

ORDERS_FILE = "orders.json"

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

# [CREATE] บันทึกบิลขายรายวัน
@app.post("/api/orders")
async def create_order(data: dict, db: Session = Depends(get_db_session)):
    date = data.get("date")
    items = data.get("items", [])
    bill_name = data.get("name", "")

    if not date:
        raise HTTPException(status_code=422, detail="Missing field: date")
    if not isinstance(items, list) or not items:
        raise HTTPException(status_code=422, detail="items must be a non-empty array")

    # --- Stock Deduction Logic ---
    for it in items:
        pn = str(it.get("part_number"))
        qty = float(it.get("quantity", 0))
        item_type = it.get("type", "new")

        inv_item = db.query(InventoryItem).filter(InventoryItem.part_number == pn).first()
        if not inv_item:
            raise HTTPException(status_code=404, detail=f"Part number {pn} not found in inventory")
        
        if item_type == 'used':
            if inv_item.used_stock < qty:
                raise HTTPException(status_code=400, detail=f"Not enough stock for {pn} (used)")
            inv_item.used_stock -= int(qty)
        else:
            if inv_item.stock < qty:
                raise HTTPException(status_code=400, detail=f"Not enough stock for {pn} (new)")
            inv_item.stock -= int(qty)

    db.commit()

    # Save order
    orders = _load_orders()
    order_obj = {
        "id": len(orders) + 1,
        "date": date,
        "name": bill_name,
        "items": items,
        "total": _compute_bill_total(items),
        "timestamp": datetime.utcnow().isoformat(),
    }
    orders.append(order_obj)
    _save_orders(orders)

    return {"message": "✅ บันทึกบิลสำเร็จ!", "bill_id": order_obj["id"]}

# [READ] ดึงประวัติบิล
@app.get("/api/orders")
async def get_orders():
    return _load_orders()

# [DELETE] ลบบิล
@app.delete("/api/orders/{bill_id}")
async def delete_order(bill_id: int):
    orders = _load_orders()
    orders = [o for o in orders if o.get("id") != bill_id]
    _save_orders(orders)
    return {"message": f"✅ ลบบิล #{bill_id} สำเร็จ!"}
