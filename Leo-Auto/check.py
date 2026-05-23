from google import genai

# ใส่ API Key ของคุณ
client = genai.Client(api_key="AIzaSyAeVJLmlO9iXSQv0D99j44EKuYjeIX1UqE")

print("🔍 รายชื่อ Model ที่ API Key ของคุณสามารถใช้ได้:")
print("-" * 30)

try:
    # ดึงรายชื่อรุ่นทั้งหมดที่ Key นี้มีสิทธิ์ใช้
    for m in client.models.list():
        # กรองดูเฉพาะรุ่นที่มีคำว่า gemini
        if "gemini" in m.name:
            print(m.name)
except Exception as e:
    print(f"เกิดข้อผิดพลาด: {e}")