/**
 * SQLite database infrastructure for Willys MCP server
 * Handles sessions, order cache, and other persistent storage needs
 */

// Dynamic imports to avoid Next.js bundling issues
let Database: any;
let sqliteVec: any;

// Only import embeddings when needed
async function getEmbeddingUtils() {
  return await import("./embeddings");
}

class WillysDatabase {
  private db: any;
  public initialized: boolean = false;
  private vectorSupport: boolean = false;

  async ensureInitialized() {
    if (this.initialized) {
      console.error("Database already initialized, skipping...");
      return;
    }

    // Check if we're in a Node.js environment
    if (typeof process === "undefined" || !process.versions?.node) {
      throw new Error("Database operations require Node.js environment");
    }

    try {
      // Dynamic imports to avoid loading in browser
      Database = (await import("better-sqlite3")).default;

      // Load sqlite-vec with dynamic import to avoid Next.js bundler issues
      // Use Function constructor to prevent bundler from statically analyzing the import
      try {
        const dynamicImport = new Function("module", "return import(module)");
        sqliteVec = await dynamicImport("sqlite-vec-darwin-arm64");
      } catch (_e) {
        sqliteVec = await import("sqlite-vec");
      }

      const path = require("node:path");
      const fs = require("node:fs");

      // Persistent data dir is configurable via WILLYS_DATA_DIR. In the HA
      // compose stack we mount the named volume `willys-mcp-data` at
      // /app/data and set WILLYS_DATA_DIR=/app/data, so the DB survives
      // `docker compose up --build --force-recreate`. Without this env, fall
      // back to process.cwd() (the legacy path) so non-docker dev still works.
      const dataDir = process.env.WILLYS_DATA_DIR || process.cwd();
      try {
        fs.mkdirSync(dataDir, { recursive: true });
      } catch (_e) {
        // Mountpoints already exist; ignore EEXIST.
      }
      const DB_PATH = path.resolve(dataDir, "willys-cache.db");
      const dbPathString = String(DB_PATH);
      console.error(`Opening Willys cache DB at ${dbPathString}`);
      this.db = new Database(dbPathString);
      console.error("Database created successfully");

      this.db.pragma("journal_mode = WAL"); // Better performance for concurrent access
      this.db.pragma("synchronous = NORMAL"); // Good balance of safety and performance
      console.error("Database pragmas set");

      // Load sqlite-vec extension for vector operations
      console.error("Loading sqlite-vec extension...");
      try {
        // Ensure we're passing the database instance correctly
        if (
          typeof sqliteVec.load === "function" &&
          this.db &&
          typeof this.db.prepare === "function"
        ) {
          console.error("sqlite-vec available methods:", Object.keys(sqliteVec));

          // Use multiple approaches to load sqlite-vec extension
          let extensionLoaded = false;

          // Approach 1: Try getLoadablePath if available
          if (typeof sqliteVec.getLoadablePath === "function") {
            try {
              const extensionPath = sqliteVec.getLoadablePath();
              console.error(
                "Loading sqlite-vec from getLoadablePath:",
                extensionPath,
              );
              console.error(
                "File exists check:",
                require("node:fs").existsSync(extensionPath),
              );
              this.db.loadExtension(extensionPath);
              extensionLoaded = true;
              console.error("sqlite-vec loaded successfully via getLoadablePath");
            } catch (pathError) {
              console.error(
                "getLoadablePath approach failed:",
                pathError instanceof Error
                  ? pathError.message
                  : String(pathError),
              );
            }
          }

          // Approach 2: Manual path construction for Next.js compatibility
          if (!extensionLoaded) {
            try {
              console.error("Trying manual path construction...");
              const path = require("node:path");
              const fs = require("node:fs");

              // Construct path manually - this works in both Node.js and Next.js
              const cwd = process.cwd();
              const manualPath = path.join(
                cwd,
                "node_modules",
                "sqlite-vec-darwin-arm64",
                "vec0.dylib",
              );
              console.error("Manual extension path:", manualPath);
              console.error("Manual path exists:", fs.existsSync(manualPath));

              if (fs.existsSync(manualPath)) {
                this.db.loadExtension(manualPath);
                extensionLoaded = true;
                console.error("sqlite-vec loaded successfully via manual path");
              } else {
                console.error(
                  "Manual path does not exist, trying generic sqlite-vec path...",
                );
                const genericPath = path.join(
                  cwd,
                  "node_modules",
                  "sqlite-vec-darwin-arm64",
                  "vec0.dylib",
                );
                if (fs.existsSync(genericPath)) {
                  this.db.loadExtension(genericPath);
                  extensionLoaded = true;
                  console.error(
                    "sqlite-vec loaded successfully via generic path",
                  );
                }
              }
            } catch (manualError) {
              console.error(
                "Manual path approach failed:",
                manualError instanceof Error
                  ? manualError.message
                  : String(manualError),
              );
            }
          }

          // Approach 3: Direct load method as last resort
          if (!extensionLoaded) {
            try {
              console.error("Trying direct sqliteVec.load method...");
              sqliteVec.load(this.db);
              extensionLoaded = true;
              console.error("sqlite-vec loaded successfully via direct load");
            } catch (directError) {
              console.error(
                "Direct load approach failed:",
                directError instanceof Error
                  ? directError.message
                  : String(directError),
              );
            }
          }

          if (extensionLoaded) {
            this.vectorSupport = true;
            console.error("✅ sqlite-vec extension loaded successfully");
          } else {
            this.vectorSupport = false;
            console.error(
              "❌ Failed to load sqlite-vec extension with all approaches",
            );
          }
        } else {
          console.warn(
            "sqlite-vec loading skipped - invalid database instance or load function",
          );
          console.warn("Details:", {
            loadFunctionExists: typeof sqliteVec.load === "function",
            dbExists: !!this.db,
            dbPrepareExists: !!(
              this.db && typeof this.db.prepare === "function"
            ),
          });
        }
      } catch (error) {
        console.error(
          "Failed to load sqlite-vec, continuing without vector support:",
          error instanceof Error ? error.message : String(error),
        );
        this.vectorSupport = false;
        // Continue without vector search capability
      }

      await this.initializeSchema();
      this.startCleanupTimer();
      this.initialized = true;
      console.error("Database initialization completed");
    } catch (error) {
      console.error("Failed to initialize database:", error);
      const err = error as NodeJS.ErrnoException;
      console.error("Error details:", {
        name: error instanceof Error ? error.name : undefined,
        message: error instanceof Error ? error.message : String(error),
        code: err?.code,
        stack:
          error instanceof Error
            ? error.stack?.split("\n").slice(0, 5)
            : undefined,
      });
      throw error;
    }
  }

  private async initializeSchema() {
    // Check if we need to migrate the order_cache table
    this.migrateOrderCacheTable();

    // Check if we need to migrate the products table for vector support
    this.migrateProductsTable();

    // Create sessions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        cookies TEXT NOT NULL,
        authenticated BOOLEAN NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);

    // Create legacy order cache table (for backward compatibility)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS order_cache (
        order_number TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        order_details TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);

    // Create new relational schema
    this.createRelationalSchema();

    // Create vector search schema
    this.createVectorSchema();

    // Create indexes for performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_order_cache_expires ON order_cache(expires_at);
      CREATE INDEX IF NOT EXISTS idx_order_cache_session ON order_cache(session_id);
    `);

    console.error("Database schema initialized successfully");

    // Run migration if needed
    if (this.needsMigration()) {
      console.error("Detected existing cache data, running migration...");
      const result = this.migrateExistingCacheToRelational();
      console.error(
        `Migration completed: ${result.migrated} orders, ${result.errors} errors`,
      );
    }

    // Check if embedding migration is needed
    if (this.needsEmbeddingMigration()) {
      const totalProducts = this.db
        .prepare("SELECT COUNT(*) as count FROM products")
        .get() as any;
      const embeddedProducts = this.db
        .prepare(
          "SELECT COUNT(*) as count FROM products WHERE name_embedding IS NOT NULL",
        )
        .get() as any;
      console.error(
        `Vector embeddings available for ${embeddedProducts.count}/${totalProducts.count} products`,
      );
      console.error(
        "💡 Run generateMissingEmbeddings() to enable full semantic search capabilities",
      );
    }
  }

  private createRelationalSchema() {
    // Enhanced orders table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        order_number TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        order_date INTEGER NOT NULL,
        delivery_date TEXT,
        status TEXT,
        total_amount REAL,
        store_name TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        raw_data TEXT
      );
    `);

    // Products master table (deduplicated)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS products (
        product_code TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        manufacturer TEXT,
        name_normalized TEXT,
        name_embedding BLOB,
        embedding_generated_at INTEGER,
        created_at INTEGER NOT NULL,
        stale_at INTEGER,
        preferred_at INTEGER,
        category TEXT
      );
    `);

    // cart_history: append-only log of successful add_to_cart calls. Used by
    // mcp__willys_preferred_add_last_cart_item — the Willys cart API itself
    // exposes no per-item timestamp, so we record our own. One row per
    // successful add (including substituted codes from the stale-retry path).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cart_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_code TEXT NOT NULL,
        name TEXT,
        added_at INTEGER NOT NULL
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cart_history_added_at
        ON cart_history(added_at DESC);
    `);

    // product_aliases: many-to-one map from a short keyword to a product
    // code. Drives the "add milk" / "add coffee" voice flow — a user-language
    // alias resolves deterministically to the exact product the user means,
    // sidestepping cross-lingual text-LIKE fuzziness (English query →
    // Swedish product name). Aliases are stored lowercase. UNIQUE(alias)
    // means one keyword can map to at most one product; to express "milk
    // could be either oat or lactose-free", use two distinct aliases like
    // 'havremjölk' and 'laktosfri mjölk' instead.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS product_aliases (
        alias TEXT PRIMARY KEY,
        product_code TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (product_code) REFERENCES products(product_code)
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_product_aliases_product_code
        ON product_aliases(product_code);
    `);

    // Categories master table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS categories (
        category_id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        name_normalized TEXT
      );
    `);

    // Order-Product relationships (purchase history)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS order_products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_number TEXT NOT NULL,
        product_code TEXT NOT NULL,
        category_id INTEGER NOT NULL,
        quantity INTEGER DEFAULT 1,
        price_value REAL,
        price_formatted TEXT,
        purchased_at INTEGER NOT NULL,
        FOREIGN KEY (order_number) REFERENCES orders(order_number) ON DELETE CASCADE,
        FOREIGN KEY (product_code) REFERENCES products(product_code),
        FOREIGN KEY (category_id) REFERENCES categories(category_id)
      );
    `);

    // Performance indexes for relational schema
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(order_date);
      CREATE INDEX IF NOT EXISTS idx_orders_expires ON orders(expires_at);
      CREATE INDEX IF NOT EXISTS idx_products_name_normalized ON products(name_normalized);
      CREATE INDEX IF NOT EXISTS idx_order_products_purchased_at ON order_products(purchased_at);
      CREATE INDEX IF NOT EXISTS idx_order_products_product_code ON order_products(product_code);
      CREATE INDEX IF NOT EXISTS idx_order_products_order_number ON order_products(order_number);
      CREATE INDEX IF NOT EXISTS idx_categories_name_normalized ON categories(name_normalized);
    `);

    console.error("Relational schema created successfully");
  }

  private createVectorSchema() {
    // 384 dims matches intfloat/multilingual-e5-small in the willys-embeddings
    // sidecar. Auto-migrate from any previous dimensionality: detect the old
    // schema via product_vectors_info row count + chunk shape and DROP/recreate
    // when it doesn't match. The vector table is purely derived data — losing
    // it just means we re-embed from `products`.
    const TARGET_DIM = 384;
    let needsRecreate = false;

    try {
      // Probe if the table already exists with a compatible schema.
      const exists = this.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='product_vectors'`,
        )
        .get();
      if (exists) {
        // Try inserting a dummy vector of the target dim — if it errors with a
        // dimension mismatch, we know we need to recreate.
        try {
          const probe = `[${new Array(TARGET_DIM).fill(0).join(",")}]`;
          this.db.exec("BEGIN");
          this.db
            .prepare(
              `INSERT OR REPLACE INTO product_vectors (product_code, name_embedding) VALUES (?, ?)`,
            )
            .run("__schema_probe__", probe);
          this.db
            .prepare(`DELETE FROM product_vectors WHERE product_code = ?`)
            .run("__schema_probe__");
          this.db.exec("COMMIT");
        } catch (probeErr) {
          this.db.exec("ROLLBACK");
          needsRecreate = true;
          console.error(
            `product_vectors dim mismatch (${probeErr instanceof Error ? probeErr.message : probeErr}) — recreating at ${TARGET_DIM} dims`,
          );
        }
      }
    } catch (_e) {
      // First run; CREATE below will handle it.
    }

    if (needsRecreate) {
      this.db.exec(`DROP TABLE IF EXISTS product_vectors`);
    }

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS product_vectors USING vec0(
        product_code TEXT PRIMARY KEY,
        name_embedding float[${TARGET_DIM}]
      );
    `);

    console.error(`Vector schema ready (${TARGET_DIM} dims)`);
  }

  private migrateProductsTable() {
    try {
      const tableInfo = this.db
        .prepare("PRAGMA table_info(products)")
        .all() as any[];

      const hasEmbeddingColumn = tableInfo.some(
        (col) => col.name === "name_embedding",
      );
      if (!hasEmbeddingColumn) {
        console.error("Adding vector support columns to products table...");
        this.db.exec(`
          ALTER TABLE products ADD COLUMN name_embedding BLOB;
          ALTER TABLE products ADD COLUMN embedding_generated_at INTEGER;
        `);
        console.error("Products table embedding-columns migration done");
      }

      // stale_at: set by markProductStale() when an add_to_cart fails for a
      // cached code. smartSearchProducts / vectorSearchProducts / hybrid skip
      // any row with stale_at NOT NULL, so the LLM never gets handed a code
      // we already know is dead.
      const hasStaleColumn = tableInfo.some((col) => col.name === "stale_at");
      if (!hasStaleColumn) {
        console.error("Adding stale_at column to products table...");
        this.db.exec(`ALTER TABLE products ADD COLUMN stale_at INTEGER`);
        console.error("Products table stale_at migration done");
      }

      // preferred_at: set by the preferred-list tools. The LLM is expected
      // to consult the preferred list first for "add X to cart" requests
      // before falling back to live API search. NULL = not preferred.
      const hasPreferredColumn = tableInfo.some(
        (col) => col.name === "preferred_at",
      );
      if (!hasPreferredColumn) {
        console.error("Adding preferred_at column to products table...");
        this.db.exec(`ALTER TABLE products ADD COLUMN preferred_at INTEGER`);
        console.error("Products table preferred_at migration done");
      }

      // category: free-text category label as returned by Willys' search /
      // cart APIs (e.g. "Smör & Margarin", "Mejeri"). Indexed for LIKE
      // matching in resolvePreferred so a query like "baking" can hit a
      // product whose name doesn't contain "baking" but whose category does.
      const hasCategoryColumn = tableInfo.some(
        (col) => col.name === "category",
      );
      if (!hasCategoryColumn) {
        console.error("Adding category column to products table...");
        this.db.exec(`ALTER TABLE products ADD COLUMN category TEXT`);
        console.error("Products table category migration done");
      }

      // description: full produktinformation text from Willys' product detail
      // endpoint (ingredients, description, marketing copy). Fed into the
      // embedding so vector search hits on words like "baking" / "matlagning"
      // that aren't in the product name. Fetched lazily by enrichPreferredItem.
      const hasDescriptionColumn = tableInfo.some(
        (col) => col.name === "description",
      );
      if (!hasDescriptionColumn) {
        console.error("Adding description column to products table...");
        this.db.exec(`ALTER TABLE products ADD COLUMN description TEXT`);
        this.db.exec(
          `ALTER TABLE products ADD COLUMN description_fetched_at INTEGER`,
        );
        console.error("Products table description migration done");
      }

      // Backfill category from order_products → categories for any row
      // missing one. Idempotent (no-op when there's nothing to fill);
      // running on every startup is cheap and self-healing if new orders
      // get ingested after this column existed.
      try {
        const r = this.db
          .prepare(
            `UPDATE products SET category = (
               SELECT c.name
                 FROM order_products op
                 JOIN categories c ON op.category_id = c.category_id
                WHERE op.product_code = products.product_code
                LIMIT 1
             )
             WHERE category IS NULL
               AND EXISTS (
                 SELECT 1 FROM order_products op
                 WHERE op.product_code = products.product_code
               )`,
          )
          .run();
        if (r.changes > 0) {
          console.error(
            `Backfilled category for ${r.changes} products from order_products.`,
          );
        }
      } catch (e) {
        console.error(
          `Category backfill failed (non-fatal): ${e instanceof Error ? e.message : e}`,
        );
      }
    } catch (error) {
      // Products table might not exist yet, will be created later
      console.error(
        "Products table migration not needed or failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private migrateOrderCacheTable() {
    try {
      // Check if order_cache table exists and has foreign key constraint
      const tableInfo = this.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='order_cache'",
        )
        .get() as any;

      if (tableInfo?.sql.includes("FOREIGN KEY")) {
        console.error(
          "Migrating order_cache table to remove foreign key constraint...",
        );

        // Backup existing data
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS order_cache_backup AS 
          SELECT * FROM order_cache;
        `);

        // Drop the old table
        this.db.exec("DROP TABLE order_cache;");

        // Recreate without foreign key
        this.db.exec(`
          CREATE TABLE order_cache (
            order_number TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            order_details TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
          );
        `);

        // Restore data
        this.db.exec(`
          INSERT INTO order_cache 
          SELECT * FROM order_cache_backup;
        `);

        // Clean up backup
        this.db.exec("DROP TABLE order_cache_backup;");

        console.error("Migration completed successfully");
      }
    } catch (error) {
      console.error(
        "No migration needed or migration failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private startCleanupTimer() {
    // Run cleanup every hour
    setInterval(
      () => {
        this.cleanup();
      },
      60 * 60 * 1000,
    );
  }

  // Session management methods
  storeSession(
    sessionId: string,
    cookies: string,
    ttlMs: number = 24 * 60 * 60 * 1000,
  ): void {
    const now = Date.now();
    const expiresAt = now + ttlMs;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions 
      (session_id, cookies, authenticated, created_at, expires_at) 
      VALUES (?, ?, 1, ?, ?)
    `);

    stmt.run(sessionId, cookies, now, expiresAt);
  }

  getSession(
    sessionId: string,
  ): { cookies: string; authenticated: boolean } | null {
    const stmt = this.db.prepare(`
      SELECT cookies, authenticated, expires_at 
      FROM sessions 
      WHERE session_id = ?
    `);

    const row = stmt.get(sessionId) as any;
    if (!row) return null;

    // Check if session has expired
    if (Date.now() > row.expires_at) {
      this.clearSession(sessionId);
      return null;
    }

    return {
      cookies: row.cookies,
      authenticated: Boolean(row.authenticated),
    };
  }

  clearSession(sessionId: string): void {
    // Clear related order cache entries first
    const orderCacheStmt = this.db.prepare(
      "DELETE FROM order_cache WHERE session_id = ?",
    );
    orderCacheStmt.run(sessionId);

    // Then clear the session
    const sessionStmt = this.db.prepare(
      "DELETE FROM sessions WHERE session_id = ?",
    );
    sessionStmt.run(sessionId);
  }

  // Order cache methods
  getCachedOrder(orderNumber: string): any | null {
    const stmt = this.db.prepare(`
      SELECT order_details, expires_at 
      FROM order_cache 
      WHERE order_number = ?
    `);

    const row = stmt.get(orderNumber) as any;
    if (!row) return null;

    // Check if cache entry has expired
    if (Date.now() > row.expires_at) {
      this.clearOrderCache(orderNumber);
      return null;
    }

    try {
      return JSON.parse(row.order_details);
    } catch (error) {
      console.error("Failed to parse cached order details:", error);
      this.clearOrderCache(orderNumber);
      return null;
    }
  }

  setCachedOrder(
    orderNumber: string,
    sessionId: string,
    orderDetails: any,
    ttlMs: number = 24 * 60 * 60 * 1000,
  ): void {
    const now = Date.now();
    const expiresAt = now + ttlMs;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO order_cache 
      (order_number, session_id, order_details, created_at, expires_at) 
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      orderNumber,
      sessionId,
      JSON.stringify(orderDetails),
      now,
      expiresAt,
    );
  }

  clearOrderCache(orderNumber?: string): void {
    if (orderNumber) {
      const stmt = this.db.prepare(
        "DELETE FROM order_cache WHERE order_number = ?",
      );
      stmt.run(orderNumber);
    } else {
      // Clear all order cache
      const stmt = this.db.prepare("DELETE FROM order_cache");
      stmt.run();
    }
  }

  clearOrderCacheBySession(sessionId: string): void {
    const stmt = this.db.prepare(
      "DELETE FROM order_cache WHERE session_id = ?",
    );
    stmt.run(sessionId);
  }

  // Cleanup expired records
  cleanup(): void {
    const now = Date.now();

    // Clean up expired sessions
    const sessionsStmt = this.db.prepare(
      "DELETE FROM sessions WHERE expires_at < ?",
    );
    const deletedSessions = sessionsStmt.run(now).changes;

    // Clean up expired order cache entries
    const orderCacheStmt = this.db.prepare(
      "DELETE FROM order_cache WHERE expires_at < ?",
    );
    const deletedOrders = orderCacheStmt.run(now).changes;

    if (deletedSessions > 0 || deletedOrders > 0) {
      console.error(
        `Database cleanup: removed ${deletedSessions} expired sessions and ${deletedOrders} expired order cache entries`,
      );
    }
  }

  // Migration methods
  migrateExistingCacheToRelational(): { migrated: number; errors: number } {
    console.error(
      "Starting migration of existing cache data to relational format...",
    );

    let migrated = 0;
    let errors = 0;

    // Get all order cache entries
    const cacheStmt = this.db.prepare(`
      SELECT order_number, session_id, order_details 
      FROM order_cache 
      WHERE expires_at > ?
    `);

    const cacheEntries = cacheStmt.all(Date.now()) as any[];
    console.error(`Found ${cacheEntries.length} cached orders to migrate`);

    for (const entry of cacheEntries) {
      try {
        const orderData = JSON.parse(entry.order_details);

        // Only migrate if it has product data
        if (orderData.categoryOrderedDeliveredProducts) {
          this.storeOrderRelational(orderData, entry.session_id);
          migrated++;

          if (migrated % 10 === 0) {
            console.error(
              `Migrated ${migrated}/${cacheEntries.length} orders...`,
            );
          }
        }
      } catch (error) {
        console.error(`Failed to migrate order ${entry.order_number}:`, error);
        errors++;
      }
    }

    console.error(
      `Migration completed: ${migrated} orders migrated, ${errors} errors`,
    );
    return { migrated, errors };
  }

  // Check if migration is needed
  private needsMigration(): boolean {
    // Don't call ensureInitialized here to avoid infinite loop
    const cacheCount = this.db
      .prepare("SELECT COUNT(*) as count FROM order_cache WHERE expires_at > ?")
      .get(Date.now()) as any;
    const relationalCount = this.db
      .prepare("SELECT COUNT(*) as count FROM orders WHERE expires_at > ?")
      .get(Date.now()) as any;

    return cacheCount.count > 0 && relationalCount.count === 0;
  }

  // Check if embedding migration is needed
  needsEmbeddingMigration(): boolean {
    // Don't call ensureInitialized here to avoid infinite loop
    // This method should only be called after database is already initialized
    if (!this.initialized || !this.vectorSupport) {
      return false;
    }

    const totalProducts = this.db
      .prepare("SELECT COUNT(*) as count FROM products")
      .get() as any;
    const embeddedProducts = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM products WHERE name_embedding IS NOT NULL",
      )
      .get() as any;

    return (
      totalProducts.count > 0 && embeddedProducts.count < totalProducts.count
    );
  }

  // Generate embeddings for all products that don't have them
  async generateMissingEmbeddings(
    batchSize: number = 50,
  ): Promise<{ processed: number; errors: number }> {
    console.error(
      "Starting embedding generation for products without embeddings...",
    );

    let processed = 0;
    let errors = 0;

    try {
      // Get products without embeddings
      const stmt = this.db.prepare(`
        SELECT product_code, name 
        FROM products 
        WHERE name_embedding IS NULL 
        ORDER BY created_at DESC
      `);

      const products = stmt.all() as Array<{
        product_code: string;
        name: string;
      }>;
      console.error(`Found ${products.length} products needing embeddings`);

      if (products.length === 0) {
        return { processed: 0, errors: 0 };
      }

      // Process in batches
      for (let i = 0; i < products.length; i += batchSize) {
        const batch = products.slice(i, i + batchSize);
        const productNames = batch.map((p) => p.name);

        try {
          console.error(
            `Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(products.length / batchSize)} (${batch.length} products)`,
          );

          const { generateEmbeddingsBatch, embeddingToBlob } =
            await getEmbeddingUtils();
          const embeddings = await generateEmbeddingsBatch(
            productNames,
            batchSize,
          );

          // Store embeddings in database
          const updateStmt = this.db.prepare(`
            UPDATE products 
            SET name_embedding = ?, embedding_generated_at = ?
            WHERE product_code = ?
          `);

          const insertVectorStmt = this.db.prepare(`
            INSERT OR REPLACE INTO product_vectors (product_code, name_embedding)
            VALUES (?, ?)
          `);

          const transaction = this.db.transaction(() => {
            for (let j = 0; j < batch.length; j++) {
              const product = batch[j];
              const embedding = embeddings[j];
              const now = Date.now();
              const blob = embeddingToBlob(embedding);

              // Update products table
              updateStmt.run(blob, now, product.product_code);

              // Insert into vector table (convert to array for vec0)
              const embeddingArray = `[${Array.from(embedding).join(",")}]`;
              insertVectorStmt.run(product.product_code, embeddingArray);
            }
          });

          transaction();
          processed += batch.length;

          console.error(`Processed ${processed}/${products.length} products`);

          // Rate limiting between batches
          if (i + batchSize < products.length) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        } catch (error) {
          console.error(`Error processing batch starting at ${i}:`, error);
          errors += batch.length;
        }
      }

      console.error(
        `Embedding generation completed: ${processed} processed, ${errors} errors`,
      );
    } catch (error) {
      console.error("Error in embedding migration:", error);
      errors++;
    }

    return { processed, errors };
  }

  // Relational data methods
  storeOrderRelational(
    orderData: any,
    sessionId: string,
    ttlMs: number = 24 * 60 * 60 * 1000,
  ): void {
    const now = Date.now();
    const expiresAt = now + ttlMs;
    const orderDate = orderData.placed || now;

    // Insert or update order
    const orderStmt = this.db.prepare(`
      INSERT OR REPLACE INTO orders 
      (order_number, session_id, order_date, delivery_date, status, total_amount, store_name, created_at, expires_at, raw_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    orderStmt.run(
      orderData.orderNumber || orderData.code,
      sessionId,
      orderDate,
      orderData.deliveryFormattedDate || null,
      orderData.statusDisplay || null,
      orderData.totalPrice?.value || 0,
      orderData.store || null,
      now,
      expiresAt,
      JSON.stringify(orderData),
    );

    // Process products from categoryOrderedDeliveredProducts
    if (orderData.categoryOrderedDeliveredProducts) {
      this.processOrderProducts(orderData, orderDate);
    }
  }

  private processOrderProducts(orderData: any, orderDate: number): void {
    const orderNumber = orderData.orderNumber || orderData.code;

    // First, remove existing order products (for updates)
    const deleteStmt = this.db.prepare(
      "DELETE FROM order_products WHERE order_number = ?",
    );
    deleteStmt.run(orderNumber);

    Object.entries(orderData.categoryOrderedDeliveredProducts).forEach(
      ([categoryName, products]: [string, any]) => {
        if (!Array.isArray(products)) return;

        // Get or create category
        const categoryId = this.getOrCreateCategory(categoryName);

        products.forEach((product: any) => {
          if (!product.code || !product.name) return;

          // Get or create product
          this.getOrCreateProduct(product);

          // Insert order-product relationship
          const orderProductStmt = this.db.prepare(`
          INSERT INTO order_products 
          (order_number, product_code, category_id, quantity, price_value, price_formatted, purchased_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

          orderProductStmt.run(
            orderNumber,
            product.code,
            categoryId,
            product.quantity || 1,
            this.extractPriceValue(product),
            product.basePrice?.formattedValue ||
              product.totalPrice?.formattedValue ||
              null,
            orderDate,
          );
        });
      },
    );
  }

  private getOrCreateCategory(categoryName: string): number {
    const normalized = categoryName.toLowerCase();

    // Try to get existing category
    const selectStmt = this.db.prepare(
      "SELECT category_id FROM categories WHERE name = ?",
    );
    const existing = selectStmt.get(categoryName) as any;

    if (existing) {
      return existing.category_id;
    }

    // Create new category
    const insertStmt = this.db.prepare(`
      INSERT INTO categories (name, name_normalized) VALUES (?, ?)
    `);

    const result = insertStmt.run(categoryName, normalized);
    return result.lastInsertRowid as number;
  }

  private getOrCreateProduct(product: any): void {
    const now = Date.now();
    const normalized = product.name.toLowerCase();

    // Insert or ignore (don't update existing products)
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO products 
      (product_code, name, manufacturer, name_normalized, name_embedding, embedding_generated_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      product.code,
      product.name,
      product.manufacturer || null,
      normalized,
      null, // name_embedding - will be generated in batch later
      null, // embedding_generated_at - will be set when embedding is generated
      now,
    );
  }

  private extractPriceValue(product: any): number | null {
    const priceStr =
      product.basePrice?.formattedValue || product.totalPrice?.formattedValue;
    if (!priceStr) return null;

    // Extract numeric value from "XX kr" format
    const match = priceStr.match(/(\d+(?:,\d+)?)/);
    if (match) {
      return parseFloat(match[1].replace(",", "."));
    }
    return null;
  }

  // Smart search with SQL
  searchProductsSQL(
    searchTerm: string,
    maxResults: number = 5,
  ): Array<{
    productCode: string;
    name: string;
    manufacturer: string | null;
    frequency: number;
    lastPurchased: number;
    recentPurchases: number;
    orderHistory: string[];
  }> {
    const stmt = this.db.prepare(`
      SELECT
        p.product_code,
        p.name,
        p.manufacturer,
        COUNT(*) as frequency,
        MAX(op.purchased_at) as last_purchased,
        SUM(CASE WHEN op.purchased_at > ? THEN 1 ELSE 0 END) as recent_purchases,
        GROUP_CONCAT(DISTINCT op.order_number) as order_history
      FROM products p
      JOIN order_products op ON p.product_code = op.product_code
      WHERE p.name_normalized LIKE ? AND p.stale_at IS NULL
      GROUP BY p.product_code, p.name, p.manufacturer
      ORDER BY
        frequency DESC,
        last_purchased DESC
      LIMIT ?
    `);

    const recentCutoff = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days ago
    const searchPattern = `%${searchTerm.toLowerCase()}%`;

    const results = stmt.all(recentCutoff, searchPattern, maxResults) as any[];

    return results.map((row) => ({
      productCode: row.product_code,
      name: row.name,
      manufacturer: row.manufacturer,
      frequency: row.frequency,
      lastPurchased: row.last_purchased,
      recentPurchases: row.recent_purchases,
      orderHistory: row.order_history ? row.order_history.split(",") : [],
    }));
  }

  // Enhanced smart search with scoring algorithm
  async smartSearchProducts(
    searchTerm: string,
    maxResults: number = 5,
  ): Promise<
    Array<{
      productCode: string;
      name: string;
      manufacturer: string | null;
      frequency: number;
      lastPurchased: number;
      recentPurchases: number;
      score: number;
    }>
  > {
    await this.ensureInitialized();
    // LEFT JOIN so the cache also returns products the LLM has searched for
    // but never actually ordered (Fix 3). The frequency/recency parts of the
    // score collapse to zero in that case, which is fine — the exact-match
    // bonus still puts a strong text hit at the top.
    const stmt = this.db.prepare(`
      SELECT
        p.product_code,
        p.name,
        p.manufacturer,
        COUNT(op.product_code) as frequency,
        MAX(op.purchased_at) as last_purchased,
        SUM(CASE WHEN op.purchased_at > ? THEN 1 ELSE 0 END) as recent_purchases,
        -- Scoring algorithm
        (
          (COUNT(op.product_code) * 10) +
          (SUM(CASE WHEN op.purchased_at > ? THEN 5 ELSE 0 END)) +
          (CASE
            WHEN LOWER(p.name) LIKE ? THEN 20
            WHEN LOWER(p.name) LIKE ? THEN 15
            ELSE 0
          END)
        ) as score
      FROM products p
      LEFT JOIN order_products op ON p.product_code = op.product_code
      WHERE p.name_normalized LIKE ? AND p.stale_at IS NULL
      GROUP BY p.product_code, p.name, p.manufacturer
      ORDER BY
        score DESC,
        frequency DESC,
        last_purchased DESC
      LIMIT ?
    `);

    const recentCutoff = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days ago
    const searchPattern = `%${searchTerm.toLowerCase()}%`;
    const exactMatch = searchTerm.toLowerCase();
    const startsWith = `${searchTerm.toLowerCase()}%`;

    const results = stmt.all(
      recentCutoff,
      recentCutoff,
      exactMatch,
      startsWith,
      searchPattern,
      maxResults,
    ) as any[];

    return results.map((row) => ({
      productCode: row.product_code,
      name: row.name,
      manufacturer: row.manufacturer,
      frequency: row.frequency,
      lastPurchased: row.last_purchased,
      recentPurchases: row.recent_purchases,
      score: row.score,
    }));
  }

  // Get frequently purchased products (for suggestions)
  getFrequentProducts(maxResults: number = 10): Array<{
    productCode: string;
    name: string;
    manufacturer: string | null;
    frequency: number;
    lastPurchased: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT 
        p.product_code,
        p.name,
        p.manufacturer,
        COUNT(*) as frequency,
        MAX(op.purchased_at) as last_purchased
      FROM products p
      JOIN order_products op ON p.product_code = op.product_code  
      GROUP BY p.product_code, p.name, p.manufacturer
      ORDER BY frequency DESC, last_purchased DESC
      LIMIT ?
    `);

    const results = stmt.all(maxResults) as any[];
    return results.map((row) => ({
      productCode: row.product_code,
      name: row.name,
      manufacturer: row.manufacturer,
      frequency: row.frequency,
      lastPurchased: row.last_purchased,
    }));
  }

  // Search by category
  searchProductsByCategory(
    categoryName: string,
    maxResults: number = 10,
  ): Array<{
    productCode: string;
    name: string;
    manufacturer: string | null;
    frequency: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT 
        p.product_code,
        p.name,
        p.manufacturer,
        COUNT(*) as frequency
      FROM products p
      JOIN order_products op ON p.product_code = op.product_code
      JOIN categories c ON op.category_id = c.category_id
      WHERE c.name_normalized LIKE ?
      GROUP BY p.product_code, p.name, p.manufacturer
      ORDER BY frequency DESC
      LIMIT ?
    `);

    const searchPattern = `%${categoryName.toLowerCase()}%`;
    const results = stmt.all(searchPattern, maxResults) as any[];

    return results.map((row) => ({
      productCode: row.product_code,
      name: row.name,
      manufacturer: row.manufacturer,
      frequency: row.frequency,
    }));
  }

  // Vector search methods
  async vectorSearchProducts(
    searchTerm: string,
    maxResults: number = 5,
  ): Promise<
    Array<{
      productCode: string;
      name: string;
      manufacturer: string | null;
      similarity: number;
      frequency?: number;
    }>
  > {
    await this.ensureInitialized();

    // Return empty results if vector support is not available
    if (!this.vectorSupport) {
      console.error(
        "Vector search requested but sqlite-vec not available, returning empty results",
      );
      return [];
    }

    try {
      // Generate embedding for search term
      const { generateEmbedding } = await getEmbeddingUtils();
      const searchEmbedding = await generateEmbedding(searchTerm);
      const searchArray = `[${Array.from(searchEmbedding).join(",")}]`;

      // Perform vector similarity search using vec0 syntax
      const stmt = this.db.prepare(`
        SELECT
          pv.product_code,
          p.name,
          p.manufacturer,
          distance as similarity_distance
        FROM product_vectors pv
        JOIN products p ON pv.product_code = p.product_code
        WHERE pv.name_embedding MATCH ?
        AND k = ?
        AND p.stale_at IS NULL
        ORDER BY distance ASC
      `);

      const results = stmt.all(searchArray, maxResults) as any[];

      // Convert distance to similarity score (smaller distance = higher similarity)
      return results.map((row) => ({
        productCode: row.product_code,
        name: row.name,
        manufacturer: row.manufacturer,
        similarity: Math.max(0, 1 - row.similarity_distance / 2), // Normalize distance to similarity (0-1)
      }));
    } catch (error) {
      console.error("Error in vector search:", error);
      return [];
    }
  }

  // Hybrid search combining text and vector results
  async hybridSearchProducts(
    searchTerm: string,
    maxResults: number = 5,
  ): Promise<
    Array<{
      productCode: string;
      name: string;
      manufacturer: string | null;
      score: number;
      frequency: number;
      similarity: number;
      source: "text" | "vector" | "both";
    }>
  > {
    await this.ensureInitialized();
    try {
      // Get text-based results
      const textResults = await this.smartSearchProducts(
        searchTerm,
        maxResults * 2,
      );

      // Get vector-based results
      const vectorResults = await this.vectorSearchProducts(
        searchTerm,
        maxResults * 2,
      );

      // Merge results by product code
      const mergedResults = new Map<string, any>();

      // Add text results
      textResults.forEach((result) => {
        mergedResults.set(result.productCode, {
          productCode: result.productCode,
          name: result.name,
          manufacturer: result.manufacturer,
          textScore: result.score,
          frequency: result.frequency,
          similarity: 0,
          source: "text" as const,
        });
      });

      // Add vector results and merge with text results
      vectorResults.forEach((result) => {
        const existing = mergedResults.get(result.productCode);
        if (existing) {
          // Combine text and vector scores
          existing.similarity = result.similarity;
          existing.source = "both";
        } else {
          mergedResults.set(result.productCode, {
            productCode: result.productCode,
            name: result.name,
            manufacturer: result.manufacturer,
            textScore: 0,
            frequency: 0,
            similarity: result.similarity,
            source: "vector" as const,
          });
        }
      });

      // Calculate combined score and sort
      const finalResults = Array.from(mergedResults.values()).map((item) => ({
        productCode: item.productCode,
        name: item.name,
        manufacturer: item.manufacturer,
        score: item.textScore * 0.6 + item.similarity * 100 * 0.4, // Weighted combination
        frequency: item.frequency,
        similarity: item.similarity,
        source: item.source,
      }));

      return finalResults
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);
    } catch (error) {
      console.error("Error in hybrid search:", error);
      // Fallback to text-only search
      return (await this.smartSearchProducts(searchTerm, maxResults)).map(
        (result) => ({
          ...result,
          similarity: 0,
          source: "text" as const,
        }),
      );
    }
  }

  // Get statistics including vector data
  async getStats(): Promise<{
    sessions: number;
    cachedOrders: number;
    relationalOrders: number;
    products: number;
    categories: number;
    embeddedProducts: number;
    vectorRecords: number;
  }> {
    await this.ensureInitialized();
    const sessionsStmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM sessions WHERE expires_at > ?",
    );
    const legacyCacheStmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM order_cache WHERE expires_at > ?",
    );
    const ordersStmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM orders WHERE expires_at > ?",
    );
    const productsStmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM products",
    );
    const categoriesStmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM categories",
    );
    const embeddedProductsStmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM products WHERE name_embedding IS NOT NULL",
    );
    const vectorRecordsStmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM product_vectors",
    );

    const now = Date.now();
    const sessions = (sessionsStmt.get(now) as any).count;
    const cachedOrders = (legacyCacheStmt.get(now) as any).count;
    const relationalOrders = (ordersStmt.get(now) as any).count;
    const products = (productsStmt.get() as any).count;
    const categories = (categoriesStmt.get() as any).count;
    const embeddedProducts = (embeddedProductsStmt.get() as any).count;
    const vectorRecords = (vectorRecordsStmt.get() as any).count;

    return {
      sessions,
      cachedOrders,
      relationalOrders,
      products,
      categories,
      embeddedProducts,
      vectorRecords,
    };
  }

  // ─── Fix 3: cache catalogue-search results ──────────────────────────────
  // Called by mcpSearchProducts() after every successful Willys API call.
  // Upserts each product into `products`. INSERT OR IGNORE preserves existing
  // rows (their manufacturer / embeddings / order_products FK refs); the
  // separate UPDATE clears any prior `stale_at` if the product reappears in
  // a search (Willys re-added it, our previous "stale" marker was wrong).
  cacheProductsFromSearch(
    products: Array<{
      code?: string;
      name?: string;
      manufacturer?: string | null;
      category?: string | null;
    }>,
  ): { inserted: number; revived: number } {
    if (!this.initialized) {
      // Search can fire before async ensureInitialized() resolves; skip
      // rather than throw — caching is best-effort.
      return { inserted: 0, revived: 0 };
    }
    const now = Date.now();
    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO products
        (product_code, name, manufacturer, name_normalized, created_at, category)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    // Backfill missing fields on existing rows (category may not have been
    // captured on first cache) without overwriting non-null values.
    const updateMetaStmt = this.db.prepare(`
      UPDATE products SET
        category = COALESCE(category, ?),
        manufacturer = COALESCE(manufacturer, ?)
      WHERE product_code = ?
    `);
    const reviveStmt = this.db.prepare(`
      UPDATE products SET stale_at = NULL WHERE product_code = ? AND stale_at IS NOT NULL
    `);
    let inserted = 0;
    let revived = 0;
    const tx = this.db.transaction(() => {
      for (const p of products) {
        if (!p.code || !p.name) continue;
        const result = insertStmt.run(
          p.code,
          p.name,
          p.manufacturer || null,
          p.name.toLowerCase(),
          now,
          p.category || null,
        );
        if (result.changes > 0) inserted++;
        else updateMetaStmt.run(p.category || null, p.manufacturer || null, p.code);
        const r = reviveStmt.run(p.code);
        if (r.changes > 0) revived++;
      }
    });
    tx();
    return { inserted, revived };
  }

  getProductNameByCode(productCode: string): string | null {
    if (!this.initialized) return null;
    const row = this.db
      .prepare("SELECT name FROM products WHERE product_code = ?")
      .get(productCode) as { name?: string } | undefined;
    return row?.name ?? null;
  }

  markProductStale(productCode: string): void {
    if (!this.initialized) return;
    this.db
      .prepare("UPDATE products SET stale_at = ? WHERE product_code = ?")
      .run(Date.now(), productCode);
  }

  // Helper for the startup backfill (Fix 2): used by mcp-server.ts to decide
  // whether to walk the user's order history. Doesn't touch session state.
  countOrders(): number {
    if (!this.initialized) return 0;
    const row = this.db
      .prepare("SELECT COUNT(*) as n FROM orders")
      .get() as { n: number };
    return row.n;
  }

  // ─── Preferred-list system ──────────────────────────────────────────────
  // A curated subset of `products` marked with `preferred_at`. The LLM is
  // expected to consult preferred FIRST when the user asks to add something
  // to the cart, so common groceries get the *exact* product the user wants
  // (specific brand, milkfat %, etc.) without re-querying Willys.

  // Upsert the product row and mark it preferred. `overwriteTimestamp`
  // controls whether an existing preferred_at gets refreshed — set true
  // for explicit re-marks (single add, replace), false for the bulk
  // "update from cart" flow that's supposed to be insert-only.
  addPreferred(
    productCode: string,
    name: string,
    manufacturer?: string | null,
    options: { overwriteTimestamp?: boolean; category?: string | null } = {},
  ): { newlyPreferred: boolean } {
    if (!this.initialized) return { newlyPreferred: false };
    const overwrite = options.overwriteTimestamp !== false;
    const now = Date.now();
    // Ensure the product row exists. INSERT OR IGNORE preserves any
    // existing manufacturer / stale_at / embedding columns.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO products
           (product_code, name, manufacturer, name_normalized, created_at, category)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        productCode,
        name,
        manufacturer || null,
        name.toLowerCase(),
        now,
        options.category || null,
      );
    // Backfill metadata on existing rows (without clobbering non-null values).
    this.db
      .prepare(
        `UPDATE products SET
           category = COALESCE(category, ?),
           manufacturer = COALESCE(manufacturer, ?)
         WHERE product_code = ?`,
      )
      .run(options.category || null, manufacturer || null, productCode);

    const sql = overwrite
      ? `UPDATE products SET preferred_at = ? WHERE product_code = ?`
      : `UPDATE products SET preferred_at = ?
           WHERE product_code = ? AND preferred_at IS NULL`;
    const r = this.db.prepare(sql).run(now, productCode);
    return { newlyPreferred: r.changes > 0 };
  }

  removePreferred(productCode: string): boolean {
    if (!this.initialized) return false;
    const r = this.db
      .prepare(
        `UPDATE products SET preferred_at = NULL
           WHERE product_code = ? AND preferred_at IS NOT NULL`,
      )
      .run(productCode);
    return r.changes > 0;
  }

  clearAllPreferred(): number {
    if (!this.initialized) return 0;
    const r = this.db
      .prepare(`UPDATE products SET preferred_at = NULL WHERE preferred_at IS NOT NULL`)
      .run();
    return r.changes;
  }

  listPreferred(): Array<{
    productCode: string;
    name: string;
    manufacturer: string | null;
    preferredAt: number;
  }> {
    if (!this.initialized) return [];
    return (this.db
      .prepare(
        `SELECT product_code, name, manufacturer, preferred_at
           FROM products
           WHERE preferred_at IS NOT NULL AND stale_at IS NULL
           ORDER BY preferred_at ASC`,
      )
      .all() as any[]).map((r) => ({
      productCode: r.product_code,
      name: r.name,
      manufacturer: r.manufacturer,
      preferredAt: r.preferred_at,
    }));
  }

  // Returns the subset of `codes` that are currently preferred (and not
  // stale). Used by the Willys-search fallback in mcp__willys_preferred_add
  // to intersect live search results with the user's preferred list.
  filterPreferredByCodes(
    codes: string[],
  ): Array<{ productCode: string; name: string; manufacturer: string | null }> {
    if (!this.initialized || codes.length === 0) return [];
    const placeholders = codes.map(() => "?").join(",");
    const stmt = this.db.prepare(
      `SELECT product_code, name, manufacturer
         FROM products
         WHERE preferred_at IS NOT NULL
           AND stale_at IS NULL
           AND product_code IN (${placeholders})
         ORDER BY preferred_at ASC`,
    );
    return (stmt.all(...codes) as any[]).map((r) => ({
      productCode: r.product_code,
      name: r.name,
      manufacturer: r.manufacturer,
    }));
  }

  searchPreferred(
    query: string,
    maxResults: number = 5,
  ): Array<{
    productCode: string;
    name: string;
    manufacturer: string | null;
  }> {
    if (!this.initialized) return [];
    const stmt = this.db.prepare(
      `SELECT product_code, name, manufacturer
         FROM products
         WHERE preferred_at IS NOT NULL
           AND stale_at IS NULL
           AND name_normalized LIKE ?
         ORDER BY
           CASE
             WHEN LOWER(name) LIKE ? THEN 0
             WHEN LOWER(name) LIKE ? THEN 1
             ELSE 2
           END,
           preferred_at ASC
         LIMIT ?`,
    );
    const q = query.toLowerCase();
    return (stmt.all(`%${q}%`, q, `${q}%`, maxResults) as any[]).map((r) => ({
      productCode: r.product_code,
      name: r.name,
      manufacturer: r.manufacturer,
    }));
  }

  // ─── Cart-history log (drives "preferred_add_last_cart_item") ───────────
  logCartAddition(productCode: string, name?: string | null): void {
    if (!this.initialized) return;
    this.db
      .prepare(
        `INSERT INTO cart_history (product_code, name, added_at) VALUES (?, ?, ?)`,
      )
      .run(productCode, name || null, Date.now());
  }

  getLastCartAddition(): { productCode: string; name: string | null } | null {
    if (!this.initialized) return null;
    const row = this.db
      .prepare(
        `SELECT product_code, name FROM cart_history ORDER BY added_at DESC LIMIT 1`,
      )
      .get() as any;
    if (!row) return null;
    return { productCode: row.product_code, name: row.name };
  }

  // ─── Aliases ────────────────────────────────────────────────────────────
  addAlias(
    alias: string,
    productCode: string,
  ): { ok: boolean; reason?: string } {
    if (!this.initialized) return { ok: false, reason: "db not initialized" };
    const normalized = alias.trim().toLowerCase();
    if (!normalized) return { ok: false, reason: "empty alias" };
    // Make sure the product exists — otherwise the alias is a dangling pointer.
    const exists = this.db
      .prepare(`SELECT 1 FROM products WHERE product_code = ?`)
      .get(productCode);
    if (!exists) {
      return {
        ok: false,
        reason: `product code ${productCode} not in cache (alias must reference a known product)`,
      };
    }
    try {
      this.db
        .prepare(
          `INSERT INTO product_aliases (alias, product_code, created_at) VALUES (?, ?, ?)`,
        )
        .run(normalized, productCode, Date.now());
      return { ok: true };
    } catch (err) {
      // UNIQUE violation: alias already taken.
      const existing = this.db
        .prepare(`SELECT product_code FROM product_aliases WHERE alias = ?`)
        .get(normalized) as { product_code?: string } | undefined;
      return {
        ok: false,
        reason: `alias "${normalized}" is already mapped to ${existing?.product_code ?? "another product"} — remove it first if you want to remap`,
      };
    }
  }

  removeAlias(alias: string): boolean {
    if (!this.initialized) return false;
    const r = this.db
      .prepare(`DELETE FROM product_aliases WHERE alias = ?`)
      .run(alias.trim().toLowerCase());
    return r.changes > 0;
  }

  listAliases(
    productCode?: string,
  ): Array<{ alias: string; productCode: string; name: string | null }> {
    if (!this.initialized) return [];
    const stmt = productCode
      ? this.db.prepare(
          `SELECT a.alias, a.product_code, p.name
             FROM product_aliases a
             LEFT JOIN products p ON a.product_code = p.product_code
             WHERE a.product_code = ?
             ORDER BY a.created_at ASC`,
        )
      : this.db.prepare(
          `SELECT a.alias, a.product_code, p.name
             FROM product_aliases a
             LEFT JOIN products p ON a.product_code = p.product_code
             ORDER BY a.alias ASC`,
        );
    const rows = (productCode ? stmt.all(productCode) : stmt.all()) as any[];
    return rows.map((r) => ({
      alias: r.alias,
      productCode: r.product_code,
      name: r.name ?? null,
    }));
  }

  // The one-shot lookup that powers `mcp__willys_preferred_add`.
  // Strategy (cheapest → fuzziest):
  //   1. Exact alias match (case-insensitive).
  //   2. Preferred-list name search (text LIKE %query%, stale_at IS NULL).
  // Dedupes by product_code so an item that matches both as alias *and* via
  // its name only appears once. Caller decides whether 1 result = add,
  // 2+ = ask the user.
  resolvePreferred(
    query: string,
    maxResults: number = 5,
  ): Array<{
    productCode: string;
    name: string;
    manufacturer: string | null;
    matchedBy: "alias" | "name" | "category";
  }> {
    if (!this.initialized) return [];
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];

    const seen = new Set<string>();
    const out: Array<{
      productCode: string;
      name: string;
      manufacturer: string | null;
      matchedBy: "alias" | "name" | "category";
    }> = [];

    // 1) Exact alias match.
    const aliasMatch = this.db
      .prepare(
        `SELECT a.product_code, p.name, p.manufacturer
           FROM product_aliases a
           JOIN products p ON a.product_code = p.product_code
           WHERE a.alias = ? AND p.stale_at IS NULL`,
      )
      .get(normalized) as any;
    if (aliasMatch) {
      out.push({
        productCode: aliasMatch.product_code,
        name: aliasMatch.name,
        manufacturer: aliasMatch.manufacturer,
        matchedBy: "alias",
      });
      seen.add(aliasMatch.product_code);
    }

    // 2) Preferred-name or category text search. Name matches outrank
    // category matches via the ORDER BY CASE so a query like "kaffe" prefers
    // a coffee-named product over something merely in the "Kaffe" category.
    const nameRows = this.db
      .prepare(
        `SELECT product_code, name, manufacturer, category,
            CASE
              WHEN name_normalized LIKE ? THEN 'name'
              WHEN LOWER(IFNULL(category, '')) LIKE ? THEN 'category'
              ELSE 'other'
            END AS match_source
           FROM products
           WHERE preferred_at IS NOT NULL
             AND stale_at IS NULL
             AND (name_normalized LIKE ? OR LOWER(IFNULL(category, '')) LIKE ?)
           ORDER BY
             CASE
               WHEN LOWER(name) = ? THEN 0
               WHEN LOWER(name) LIKE ? THEN 1
               WHEN name_normalized LIKE ? THEN 2
               ELSE 3
             END,
             preferred_at ASC
           LIMIT ?`,
      )
      .all(
        `%${normalized}%`,
        `%${normalized}%`,
        `%${normalized}%`,
        `%${normalized}%`,
        normalized,
        `${normalized}%`,
        `%${normalized}%`,
        maxResults,
      ) as any[];
    for (const r of nameRows) {
      if (seen.has(r.product_code)) continue;
      out.push({
        productCode: r.product_code,
        name: r.name,
        manufacturer: r.manufacturer,
        matchedBy: r.match_source === "category" ? "category" : "name",
      });
      seen.add(r.product_code);
      if (out.length >= maxResults) break;
    }

    return out;
  }

  // ─── Description + embedding for preferred items ───────────────────────
  // Persists the produktinformation text. Called by mcp-server.ts's
  // enrichPreferredItem after a successful mcpGetProductDetail.
  storeProductDescription(productCode: string, description: string): void {
    if (!this.initialized) return;
    this.db
      .prepare(
        `UPDATE products SET description = ?, description_fetched_at = ? WHERE product_code = ?`,
      )
      .run(description, Date.now(), productCode);
  }

  // Persists the embedding into BOTH the products column (BLOB, for migration
  // and debugging) and the vec0 virtual table (which actually drives k-NN).
  storeProductEmbedding(
    productCode: string,
    embedding: Float32Array,
  ): void {
    if (!this.initialized || !this.vectorSupport) return;
    const blob = Buffer.from(embedding.buffer);
    const arrayLiteral = `[${Array.from(embedding).join(",")}]`;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE products SET name_embedding = ?, embedding_generated_at = ? WHERE product_code = ?`,
        )
        .run(blob, Date.now(), productCode);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO product_vectors (product_code, name_embedding) VALUES (?, ?)`,
        )
        .run(productCode, arrayLiteral);
    });
    tx();
  }

  // Preferred items that still need to be embedded. Drives the startup
  // backfill in mcp-server.ts.
  listPreferredMissingEmbedding(): Array<{
    productCode: string;
    name: string;
    manufacturer: string | null;
    category: string | null;
    description: string | null;
  }> {
    if (!this.initialized) return [];
    return (this.db
      .prepare(
        `SELECT product_code, name, manufacturer, category, description
           FROM products
           WHERE preferred_at IS NOT NULL
             AND stale_at IS NULL
             AND embedding_generated_at IS NULL`,
      )
      .all() as any[]).map((r) => ({
      productCode: r.product_code,
      name: r.name,
      manufacturer: r.manufacturer,
      category: r.category,
      description: r.description,
    }));
  }

  // Preferred items that need description fetched (from Willys product detail).
  listPreferredMissingDescription(): Array<{
    productCode: string;
    name: string;
  }> {
    if (!this.initialized) return [];
    return (this.db
      .prepare(
        `SELECT product_code, name FROM products
           WHERE preferred_at IS NOT NULL
             AND stale_at IS NULL
             AND description_fetched_at IS NULL`,
      )
      .all() as any[]).map((r) => ({
      productCode: r.product_code,
      name: r.name,
    }));
  }

  // K-NN search filtered to preferred-only, stale-skipped. Returns ordered
  // list with similarity in [0, 1] (cosine, derived from vec0 L2 distance on
  // unit-normalized vectors: similarity = 1 - distance/2).
  // Callers should apply a confidence threshold (~0.75 is sensible for
  // multilingual-e5-small on grocery queries) before treating as a hit.
  vectorSearchPreferred(
    queryEmbedding: Float32Array,
    maxResults: number = 5,
  ): Array<{
    productCode: string;
    name: string;
    manufacturer: string | null;
    similarity: number;
  }> {
    if (!this.initialized || !this.vectorSupport) return [];
    try {
      const arrayLiteral = `[${Array.from(queryEmbedding).join(",")}]`;
      const stmt = this.db.prepare(
        `SELECT
           pv.product_code,
           p.name,
           p.manufacturer,
           distance AS d
         FROM product_vectors pv
         JOIN products p ON pv.product_code = p.product_code
         WHERE pv.name_embedding MATCH ?
           AND k = ?
           AND p.preferred_at IS NOT NULL
           AND p.stale_at IS NULL
         ORDER BY distance ASC`,
      );
      const rows = stmt.all(arrayLiteral, maxResults) as any[];
      return rows.map((r) => ({
        productCode: r.product_code,
        name: r.name,
        manufacturer: r.manufacturer,
        similarity: Math.max(0, 1 - r.d / 2),
      }));
    } catch (e) {
      console.error(
        `vectorSearchPreferred failed: ${e instanceof Error ? e.message : e}`,
      );
      return [];
    }
  }

  // Close database connection
  close(): void {
    this.db.close();
  }
}

// Global database instance
let _willysDatabase: WillysDatabase | null = null;

export function getWillysDatabase(): WillysDatabase {
  if (!_willysDatabase) {
    _willysDatabase = new WillysDatabase();
    _willysDatabase.ensureInitialized();
  }
  return _willysDatabase;
}

// For backwards compatibility
export const willysDatabase = getWillysDatabase();

// Graceful shutdown (only in Node.js environment)
if (typeof process !== "undefined" && process.versions?.node) {
  process.on("exit", () => {
    if (_willysDatabase?.initialized) {
      _willysDatabase.close();
    }
  });

  process.on("SIGINT", () => {
    if (_willysDatabase?.initialized) {
      _willysDatabase.close();
    }
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    if (_willysDatabase?.initialized) {
      _willysDatabase.close();
    }
    process.exit(0);
  });
}
