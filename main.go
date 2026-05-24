package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/joho/godotenv"
)

type Product struct {
	ID          string `json:"id"`
	PartNumber  string `json:"part_number"`
	Brand       string `json:"brand"`
	Series      string `json:"series"`
	Description string `json:"description"`
	NewItem     int    `json:"new_item"`
	UsedItem    int    `json:"used_item"`
	NewPrice    int    `json:"new_price"`
	UsedPrice   int    `json:"used_price"`
}

var (
	db    *sql.DB
	mutex = &sync.Mutex{}
)

func initDB() {
	// Load .env file if it exists (for local development)
	godotenv.Load()

	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		// For Railway, it might be provided via a different variable name.
		// Let's check for the common Railway variable.
		databaseURL = os.Getenv("PG_DATABASE_URL")
		if databaseURL == "" {
			log.Fatal("DATABASE_URL or PG_DATABASE_URL is not set in the environment")
		}
	}

	var err error
	db, err = sql.Open("pgx", databaseURL)
	if err != nil {
		log.Fatalf("Unable to connect to database: %v\n", err)
	}

	if err = db.Ping(); err != nil {
		log.Fatalf("Unable to ping database: %v\n", err)
	}

	fmt.Println("Successfully connected to the database!")

	// Create the products table if it doesn't exist
	createTableSQL := `
	CREATE TABLE IF NOT EXISTS products (
		id TEXT PRIMARY KEY,
		part_number TEXT,
		brand TEXT,
		series TEXT,
		description TEXT,
		new_item INTEGER,
		used_item INTEGER,
		new_price INTEGER,
		used_price INTEGER
	);
	`
	_, err = db.Exec(createTableSQL)
	if err != nil {
		log.Fatalf("Failed to create table: %v\n", err)
	}
	fmt.Println("Products table is ready.")
}

func loadProducts() ([]Product, error) {
	rows, err := db.Query("SELECT id, part_number, brand, series, description, new_item, used_item, new_price, used_price FROM products ORDER BY id ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var products []Product
	for rows.Next() {
		var p Product
		if err := rows.Scan(&p.ID, &p.PartNumber, &p.Brand, &p.Series, &p.Description, &p.NewItem, &p.UsedItem, &p.NewPrice, &p.UsedPrice); err != nil {
			return nil, err
		}
		products = append(products, p)
	}
	return products, nil
}

func productsHandler(w http.ResponseWriter, r *http.Request) {
	// Enable CORS
    w.Header().Set("Access-Control-Allow-Origin", "*")
    w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
    w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

    if r.Method == http.MethodOptions {
        w.WriteHeader(http.StatusOK)
        return
    }

	mutex.Lock()
	defer mutex.Unlock()

	switch r.Method {
	case http.MethodGet:
		products, err := loadProducts()
		if err != nil {
			http.Error(w, "Failed to load products", http.StatusInternalServerError)
			log.Printf("Error loading products: %v", err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(products)

	case http.MethodPost:
		var p Product
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		// Generate a simple numeric ID
		var maxID int
		err := db.QueryRow("SELECT COALESCE(MAX(CAST(id AS INTEGER)), 0) FROM products").Scan(&maxID)
		if err != nil {
			http.Error(w, "Failed to generate new ID", http.StatusInternalServerError)
			log.Printf("Error getting max ID: %v", err)
			return
		}
		p.ID = strconv.Itoa(maxID + 1)

		stmt := `INSERT INTO products (id, part_number, brand, series, description, new_item, used_item, new_price, used_price) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`
		_, err = db.Exec(stmt, p.ID, p.PartNumber, p.Brand, p.Series, p.Description, p.NewItem, p.UsedItem, p.NewPrice, p.UsedPrice)
		if err != nil {
			http.Error(w, "Failed to add product", http.StatusInternalServerError)
			log.Printf("Error adding product: %v", err)
			return
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(p)

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func productHandler(w http.ResponseWriter, r *http.Request) {
	// Enable CORS
    w.Header().Set("Access-Control-Allow-Origin", "*")
    w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
    w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

    if r.Method == http.MethodOptions {
        w.WriteHeader(http.StatusOK)
        return
    }

	mutex.Lock()
	defer mutex.Unlock()

	id := strings.TrimPrefix(r.URL.Path, "/api/products/")

	switch r.Method {
	case http.MethodPut:
		var p Product
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		stmt := `UPDATE products SET part_number=$1, brand=$2, series=$3, description=$4, new_item=$5, used_item=$6, new_price=$7, used_price=$8 WHERE id=$9`
		_, err := db.Exec(stmt, p.PartNumber, p.Brand, p.Series, p.Description, p.NewItem, p.UsedItem, p.NewPrice, p.UsedPrice, id)
		if err != nil {
			http.Error(w, "Failed to update product", http.StatusInternalServerError)
			log.Printf("Error updating product: %v", err)
			return
		}
		w.WriteHeader(http.StatusOK)

	case http.MethodDelete:
		stmt := `DELETE FROM products WHERE id=$1`
		_, err := db.Exec(stmt, id)
		if err != nil {
			http.Error(w, "Failed to delete product", http.StatusInternalServerError)
			log.Printf("Error deleting product: %v", err)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func main() {
	initDB()
	// defer db.Close() is not used here because main() runs forever.
	// A real-world app would handle graceful shutdown.

	fs := http.FileServer(http.Dir("./frontend"))
	http.Handle("/", fs)
	http.HandleFunc("/api/products", productsHandler)
	http.HandleFunc("/api/products/", productHandler)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	fmt.Printf("Server starting on port %s\n", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}