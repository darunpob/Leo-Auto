# 🚚 Leo Auto - Inventory Management System

A comprehensive inventory management system for truck parts with AI-powered features using Google Gemini API. This project combines a FastAPI backend with a modern web frontend for efficient stock management, order tracking, and intelligent part identification.

## 🌟 Features

### Core Inventory Management
- **CRUD Operations**: Create, read, update, and delete truck parts
- **Real-time Stock Tracking**: Monitor inventory levels and storage locations
- **Cost Management**: Track cost prices and compute inventory value
- **Image Support**: Upload and manage part images with automatic URL handling

### 🤖 AI Features
- **Smart Chat**: Natural language queries about inventory using Gemini 2.5 Flash
- **Vision Recognition**: AI-powered image scanning to identify truck parts by photo
- **Inventory Summary Report**: Automated analysis with insights on stock levels, high-value items, and risk assessment

### 📋 Order Management
- **Daily Bill Tracking**: Record sales orders with date and item details
- **Automatic Bill Numbering**: Sequential bill number generation
- **Total Computation**: Automatic calculation of order totals

### 🌐 Web Interface
- Clean, responsive HTML frontend
- CORS-enabled API for cross-origin requests
- Static file serving for product images

## 📁 Project Structure

```
.
├── main.py                 # FastAPI backend application
├── frontend/
│   └── index.html         # Web UI
├── inventory.csv          # Inventory database
├── orders.json            # Orders database
├── check.py               # Utility script
├── requirements.txt       # Python dependencies
├── picture/               # Product images directory
├── leo/                   # Additional resources
├── inv_api.json          # Sample API data
└── orders_payload.json   # Sample order payload
```

## 🚀 Quick Start

### Prerequisites
- Python 3.8+
- Google Generative AI API Key
- Windows/Linux/macOS

### Installation

1. **Clone or download the project**
   ```bash
   cd "g:\BangkokU\Buyear3\Term2\cs460\Final Project"
   ```

2. **Create a virtual environment** (recommended)
   ```bash
   python -m venv .venv
   .venv\Scripts\activate  # Windows
   # or
   source .venv/bin/activate  # macOS/Linux
   ```

3. **Install dependencies**
   ```bash
   pip install -r requirements.txt
   ```

4. **Set up environment variables**
   - Get your Google Generative AI API Key from [Google AI Studio](https://aistudio.google.com/app/apikey)
   - Add it to `main.py` (line 15):
     ```python
     GOOGLE_API_KEY = "your-api-key-here"
     ```
   ⚠️ **Security Note**: Never commit API keys to GitHub. Use environment variables in production.

5. **Run the server**
   ```bash
   python main.py
   ```
   The API will be available at `http://localhost:8000`

## 📚 API Documentation

### Inventory Endpoints

#### Get All Products
```http
GET /api/inventory
```

#### Add New Product
```http
POST /api/inventory
Content-Type: multipart/form-data

part_number (string, required)
part_name (string, required)
brand (string, required)
series (string, required)
price (float, required)
stock (int, required)
cost_price (float, optional)
location (string, optional)
image (file, optional)
```

#### Update Product
```http
PUT /api/inventory/{part_number}
Content-Type: multipart/form-data

[Same fields as POST]
```

#### Delete Product
```http
DELETE /api/inventory/{part_number}
```

### AI Features

#### Chat with Inventory AI
```http
POST /api/chat
Content-Type: application/x-www-form-urlencoded

question=your_question_here
```
Responds in Thai with product availability and pricing.

#### Image-Based Part Recognition
```http
POST /api/vision
Content-Type: multipart/form-data

file=image_file
```
Analyzes an image and identifies the truck part with Part Number from inventory.

#### Get Inventory Summary Report
```http
GET /api/summary
```
Returns AI-generated intelligence report including:
- Low stock items
- High-value inventory
- Risk assessment
- Executive summary

### Order Endpoints

#### Create Order/Bill
```http
POST /api/orders
Content-Type: application/json

{
  "date": "2026-05-15",
  "items": [
    {
      "part_number": "FDH02032L-Y",
      "part_name": "Door Mirror - Left",
      "quantity": 2,
      "unit_price": 1500
    }
  ]
}
```

#### Get Orders by Date
```http
GET /api/orders?date=2026-05-15
```

## 🗂️ Database Schema

### inventory.csv Columns
| Column | Type | Description |
|--------|------|-------------|
| Part Number | String | Unique identifier |
| Part Name | String | Product name |
| Brand | String | Manufacturer brand |
| Series | String | Product series |
| Price | Float | Selling price |
| Stock | Integer | Quantity available |
| Image_URL | String | Path to product image |
| Storage Location | String | Warehouse location |
| Cost Price | Float | Purchase cost |

### orders.json Structure
```json
[
  {
    "bill_no": 1,
    "date": "2026-05-15",
    "items": [...],
    "total": 5000.00
  }
]
```

## 🛠️ Technologies Used

- **Backend**: FastAPI, Uvicorn
- **Data Processing**: Pandas, Pillow (PIL)
- **AI/ML**: Google Generative AI (Gemini 2.5 Flash)
- **Web**: HTML5, CORS middleware
- **Database**: CSV + JSON (for lightweight deployment)

## 🔐 Security Considerations

1. **API Key Management**
   - Never hardcode API keys in production
   - Use environment variables or secure vaults
   - The included API key is for development only

2. **CORS Settings**
   - Currently allows all origins (`allow_origins=["*"]`)
   - Restrict to specific domains in production

3. **File Uploads**
   - Validates image extensions
   - Consider adding file size limits for security

## 📝 Sample Usage

### Using the Chat API (Thai Language)
```bash
curl -X POST http://localhost:8000/api/chat \
  -F "question=FDH02032L-Y มีสต็อกเท่าไร?"
```

### Adding an Inventory Item
```bash
curl -X POST http://localhost:8000/api/inventory \
  -F "part_number=FDH02032L-Y" \
  -F "part_name=Door Mirror - Left" \
  -F "brand=Leo" \
  -F "series=Premium" \
  -F "price=1500" \
  -F "stock=10" \
  -F "cost_price=900" \
  -F "location=Shelf A1" \
  -F "image=@path/to/image.png"
```

## 🚨 Troubleshooting

### Import Errors
Ensure all dependencies are installed:
```bash
pip install -r requirements.txt
```

### Image Not Showing
- Check if `/picture` directory exists (auto-created on first run)
- Verify image file format (PNG, JPG, JPEG, WebP, GIF supported)
- Check image filename matches Part Number format

### AI Services Failing
- Verify Google API key is valid and has quota
- Check internet connection
- Review API rate limits

## 📖 Usage Examples

### Frontend Integration
The frontend (`index.html`) should include API calls to:
```javascript
// Get inventory
fetch('/api/inventory').then(r => r.json())

// Add product
const formData = new FormData();
formData.append('part_number', 'FDH02032L-Y');
// ... other fields
fetch('/api/inventory', { method: 'POST', body: formData })

// Chat with AI
fetch('/api/chat', { 
  method: 'POST',
  body: new FormData({ question: 'مثالي؟' })
})
```

## 📊 Data Files

- **inventory.csv**: Persisted on every CRUD operation
- **orders.json**: Appended on each new order
- **picture/**: Local image storage (auto-created)

## 🎓 Course Information

**Course**: CS460  
**University**: Bangkok University  
**Year**: 3 | **Term**: 2  
**Project Type**: Final Project

## 📞 Support

For issues or questions:
1. Check the troubleshooting section
2. Review API documentation
3. Verify all dependencies are installed
4. Check file permissions in the `picture/` directory

## 📄 License

This project is developed for educational purposes.

---

**Last Updated**: May 2026  
**Version**: 1.0.0
