import os
from sqlalchemy import create_engine, Column, String, Float, Integer, Text, DateTime
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime
import psycopg2
from psycopg2.extras import execute_values

# Get DATABASE_URL from environment or use a default
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:password@localhost/leo_auto")

# SQLAlchemy setup
engine = create_engine(DATABASE_URL, echo=False, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class InventoryItem(Base):
    __tablename__ = "inventory"
    
    part_number = Column(String, primary_key=True, index=True)
    part_name = Column(String, index=True)
    brand = Column(String, index=True)
    series = Column(String, index=True)
    price = Column(Float, default=0)
    stock = Column(Integer, default=0)
    used_price = Column(Float, default=0)
    used_stock = Column(Integer, default=0)
    image_url = Column(Text, default="")
    storage_location = Column(String, default="")
    cost_price = Column(Float, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Order(Base):
    __tablename__ = "orders"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    date = Column(String)  # "YYYY-MM-DD"
    bill_name = Column(String, default="")
    items_json = Column(Text)  # JSON string
    total = Column(Float, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)


# Create tables
def init_db():
    Base.metadata.create_all(bind=engine)
    print("✓ Database tables created/verified")


def get_db():
    """Get database session"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
