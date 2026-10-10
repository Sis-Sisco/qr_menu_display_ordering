// ---------------------------------------------------------------------------
// Standalone Migration CLI: JSON Database -> MongoDB with 5-Language Seeds
// Usage: npm run migrate (or node server/migrate.js)
// ---------------------------------------------------------------------------
const path = require("path");
const fs = require("fs");
const { connectDB, getCollections, closeDB } = require("./db");
const { hashPassword, ROLES } = require("./security");

const JSON_DB_PATH = path.join(__dirname, "data", "db.json");

// Multilingual Seed Menu Items with all 5 Languages (en, ar, am, om, ti)
const SEED_MENU_ITEMS = [
  {
    id: "m1",
    category: "Food",
    cost: 450,
    available: true,
    image: "https://images.unsplash.com/photo-1604382355076-af4b0eb60143?auto=format&fit=crop&w=600&q=80",
    translations: {
      en: {
        name: "Margherita Pizza",
        description: "Crispy stone-baked pizza with fresh basil, mozzarella, and san marzano tomato sauce",
        ingredients: ["Dough", "Tomato sauce", "Mozzarella", "Fresh Basil", "Olive Oil"]
      },
      ar: {
        name: "بيتزا مارغريتا",
        description: "بيتزا مقرمشة مخبوزة على الحجر مع الريحان الطازج وجبنة الموزاريلا وصلصة الطماطم",
        ingredients: ["عجينة", "صلصة طماطم", "موزاريلا", "ريحان طازج", "زيت زيتون"]
      },
      am: {
        name: "ማርጋሪታ ፒዛ",
        description: "ትኩስ ባሲል፣ ሞዛሬላ አይብ እና የቲማቲም ድልህ ያለው ጥርት ያለ ፒዛ",
        ingredients: ["ሊጥ", "የቲማቲም ድልህ", "ሞዛሬላ", "ትኩስ ባሲል", "የወይራ ዘይት"]
      },
      om: {
        name: "Maargariitaa Piizaa",
        description: "Piizaa goggogaa baazilii haaraa, aayibii mozaarellaa fi dhangala'aa timaatimaa qabu",
        ingredients: ["Bukaawaa", "Dhangala'aa Timaatimaa", "Mozaarellaa", "Baazilii", "Zayita Zaytunaa"]
      },
      ti: {
        name: "ማርጋሪታ ፒዛ",
        description: "ትኩስ ባሲል፣ ሞዛሬላ ኣይብን ድልህ ኮሚደረን ዘለዎ ጥዑም ፒዛ",
        ingredients: ["ሊጥ", "ድልህ ኮሚደረ", "ሞዛሬላ", "ትኩስ ባሲል", "ዘይቲ ኣውሊዕ"]
      }
    }
  },
  {
    id: "m2",
    category: "Food",
    cost: 380,
    available: true,
    image: "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=600&q=80",
    translations: {
      en: {
        name: "Grilled Chicken Burger",
        description: "Juicy grilled chicken breast with crisp lettuce, ripe tomato, and herb mayo on a brioche bun",
        ingredients: ["Brioche Bun", "Chicken Breast", "Romaine Lettuce", "Herb Mayo", "Tomato"]
      },
      ar: {
        name: "برغر دجاج مشوي",
        description: "صدر دجاج مشوي مع خس طازج، طماطم ومايونيز بالأعشاب في خبز البريوش",
        ingredients: ["خبز بريوش", "صدر دجاج", "خس روماني", "مايونيز أعشاب", "طماطم"]
      },
      am: {
        name: "የተጠበሰ የዶሮ በርገር",
        description: "የተጠበሰ የዶሮ ስጋ ከሰላጣ፣ ቲማቲም እና ማዮኔዝ ጋር በልዩ ዳቦ",
        ingredients: ["ዳቦ", "የዶሮ ስጋ", "ሰላጣ", "ማዮኔዝ", "ቲማቲም"]
      },
      om: {
        name: "Burgarii Lukkuu Waaddame",
        description: "Foon lukkuu waaddame salaaxaa, timaatima fi maayoneezii waliin daabboo irratti",
        ingredients: ["Daabboo", "Foon Lukkuu", "Salaaxaa", "Maayoneezii", "Timaatima"]
      },
      ti: {
        name: "ዝተጠብሰ በርገር ደርሆ",
        description: "ዝተጠብሰ ስጋ ደርሆ ምስ ሰላጣ፣ ኮሚደረን ማዮኔዝን ኣብ ፍሉይ ባኒ",
        ingredients: ["ባኒ", "ስጋ ደርሆ", "ሰላጣ", "ማዮኔዝ", "ኮሚደረ"]
      }
    }
  },
  {
    id: "m3",
    category: "Food",
    cost: 320,
    available: true,
    image: "https://images.unsplash.com/photo-1546793665-c74683f339c1?auto=format&fit=crop&w=600&q=80",
    translations: {
      en: {
        name: "Caesar Salad",
        description: "Crisp romaine lettuce, aged parmesan shavings, garlic croutons, and creamy caesar dressing",
        ingredients: ["Romaine Lettuce", "Parmesan", "Garlic Croutons", "Caesar Dressing"]
      },
      ar: {
        name: "سلطة سيزر",
        description: "خس روماني مقرمش، شرائح جبنة بارميزان معتقة، قطع خبز محمصة بالثوم وتتبيلة سيزر كريمية",
        ingredients: ["خس روماني", "بارميزان", "خبز محمص بالثوم", "تتبيلة سيزر"]
      },
      am: {
        name: "የቄሳር ሰላጣ",
        description: "ትኩስ ሰላጣ፣ የፓርሜሳን አይብ፣ የነጭ ሽንኩርት ቂጣ ቁርጥራጭ እና የቄሳር ድልህ",
        ingredients: ["ሰላጣ", "ፓርሜሳን አይብ", "የነጭ ሽንኩርት ቂጣ", "የቄሳር ድልህ"]
      },
      om: {
        name: "Salaaxaa Qeesaar",
        description: "Salaaxaa haaraa, aayibii paarmeezaan, daabboo qullubbii adii fi qeesaar soosii waliin",
        ingredients: ["Salaaxaa", "Paarmeezaan", "Daabboo Qullubbii", "Soosii Qeesaar"]
      },
      ti: {
        name: "ሰላጣ ቄሳር",
        description: "ትኩስ ሰላጣ፣ ፓርሜሳን ኣይብ፣ ቁራጽ ባኒ ጻዕዳ ሽጉርትን ፍሉይ ድልህን",
        ingredients: ["ሰላጣ", "ፓርሜሳን ኣይብ", "ቁራጽ ባኒ ጻዕዳ ሽጉርቲ", "ድልህ ቄሳር"]
      }
    }
  },
  {
    id: "d1",
    category: "Drinks",
    cost: 60,
    available: true,
    image: "https://images.unsplash.com/photo-1510591509098-f4fdc6d0ff04?auto=format&fit=crop&w=600&q=80",
    translations: {
      en: {
        name: "Espresso",
        description: "Rich and bold single-origin Ethiopian double espresso with golden crema",
        ingredients: []
      },
      ar: {
        name: "إسبريسو",
        description: "إسبريسو إثيوبي فاخر ومزدوج بنكهة غنية وكريمة ذهبية",
        ingredients: []
      },
      am: {
        name: "ኤስፕሬሶ ቡና",
        description: "ጥንካሬ ያለው ምርጥ የኢትዮጵያ ንጹህ ኤስፕሬሶ ቡና",
        ingredients: []
      },
      om: {
        name: "Buna Isphireesoo",
        description: "Buna dhandhama gaarii qabu kan biyya Itoophiyaa",
        ingredients: []
      },
      ti: {
        name: "ኤስፕሬሶ ቡን",
        description: "ጥዑም ንጹህ ናይ ኢትዮጵያ ኤስፕሬሶ ቡን",
        ingredients: []
      }
    }
  },
  {
    id: "d2",
    category: "Drinks",
    cost: 150,
    available: true,
    image: "https://images.unsplash.com/photo-1613478223719-2ab802602423?auto=format&fit=crop&w=600&q=80",
    translations: {
      en: {
        name: "Fresh Orange Juice",
        description: "100% freshly squeezed ripe Valencia oranges served chilled over ice",
        ingredients: []
      },
      ar: {
        name: "عصير برتقال طازج",
        description: "عصير برتقال طازج 100% معصور طبيعياً ويقدم بارداً مع الثلج",
        ingredients: []
      },
      am: {
        name: "ትኩስ ብርቱካን ጭማቂ",
        description: "100% ንጹህ የተፈጥሮ የብርቱካን ጭማቂ ከበረዶ ጋር የቀረበ",
        ingredients: []
      },
      om: {
        name: "Juusii Birtukaanaa Haaraa",
        description: "Dhangala'aa birtukaanaa haaraa qulqullina qabu cabaqii waliin",
        ingredients: []
      },
      ti: {
        name: "ትኩስ ጽሟቕ ብርቱካን",
        description: "100% ንጹህ ናይ ብርቱካን ጽሟቕ ምስ በረድ ዝቐረበ",
        ingredients: []
      }
    }
  }
];

async function runMigration() {
  console.log("==========================================================");
  console.log(" 🚀 Starting 5-Language JSON -> MongoDB Migration");
  console.log("==========================================================\n");

  let jsonData = { menu: [], tables: [], orders: [], users: [], dailyCounters: {}, auditLogs: [] };

  if (fs.existsSync(JSON_DB_PATH)) {
    try {
      const raw = fs.readFileSync(JSON_DB_PATH, "utf-8");
      jsonData = JSON.parse(raw);

      const backupPath = path.join(__dirname, "data", `db.json.bak.${Date.now()}`);
      fs.writeFileSync(backupPath, raw, "utf-8");
      console.log(`✓ Safety backup created: ${backupPath}`);
    } catch (e) {
      console.error("❌ Failed to parse legacy db.json:", e.message);
      process.exit(1);
    }
  }

  await connectDB();
  const collections = getCollections();

  console.log("\n📦 Migrating collections to MongoDB...");

  // 1. Users
  const defaultStaff = [
    { username: "sisay", fullName: "Sisay Admin", role: ROLES.ADMIN, pass: "sisay1234" },
    { username: "helen", fullName: "Helen Manager", role: ROLES.MANAGER, pass: "helen1234" },
    { username: "john", fullName: "John Waiter", role: ROLES.WAITER, pass: "john1234" },
    { username: "mike", fullName: "Mike Chef", role: ROLES.KITCHEN_STAFF, pass: "mike1234" },
    { username: "sara", fullName: "Sara Cashier", role: ROLES.CASHIER, pass: "sara1234" },
  ];

  let migratedUsers = 0;
  for (const staff of defaultStaff) {
    const existing = (jsonData.users || []).find((u) => u.username && u.username.toLowerCase() === staff.username);
    const passwordHash = existing && existing.passwordHash ? existing.passwordHash : hashPassword(staff.pass).hash;
    const salt = existing && existing.salt ? existing.salt : hashPassword(staff.pass).salt;

    await collections.users.updateOne(
      { username: staff.username },
      {
        $setOnInsert: {
          id: existing?.id || "usr_" + staff.username,
          fullName: existing?.fullName || staff.fullName,
          username: staff.username,
          role: staff.role,
          status: "ACTIVE",
          passwordHash,
          salt,
          createdAt: existing?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastLoginAt: existing?.lastLoginAt || null,
        },
      },
      { upsert: true }
    );
    migratedUsers++;
  }
  console.log(`✓ Users collection migrated (${migratedUsers} accounts).`);

  // 2. Menu Items
  let migratedMenu = 0;
  for (const item of SEED_MENU_ITEMS) {
    await collections.menuItems.updateOne(
      { id: item.id },
      {
        $set: {
          id: item.id,
          name: item.translations.en.name,
          category: item.category,
          cost: item.cost,
          available: item.available,
          image: item.image,
          translations: item.translations,
          updatedAt: new Date().toISOString(),
        },
        $setOnInsert: { createdAt: new Date().toISOString() },
      },
      { upsert: true }
    );
    migratedMenu++;
  }

  for (const customItem of jsonData.menu || []) {
    if (!SEED_MENU_ITEMS.some((s) => s.id === customItem.id)) {
      const enName = typeof customItem.name === "object" ? customItem.name.en : customItem.name;
      const enDesc = typeof customItem.description === "object" ? customItem.description.en : (customItem.description || "");
      const enIng = typeof customItem.ingredients === "object" && !Array.isArray(customItem.ingredients) ? (customItem.ingredients.en || []) : (customItem.ingredients || []);

      const translations = {
        en: { name: enName, description: enDesc, ingredients: enIng }
      };

      ["ar", "am", "om", "ti"].forEach((l) => {
        const n = typeof customItem.name === "object" ? customItem.name[l] : "";
        const d = typeof customItem.description === "object" ? customItem.description[l] : "";
        const i = typeof customItem.ingredients === "object" && !Array.isArray(customItem.ingredients) ? (customItem.ingredients[l] || []) : [];
        if (n || d || i.length > 0) {
          translations[l] = { name: n || enName, description: d || enDesc, ingredients: i || enIng };
        }
      });

      await collections.menuItems.updateOne(
        { id: customItem.id },
        {
          $set: {
            id: customItem.id,
            name: enName,
            category: customItem.category || "Food",
            cost: parseFloat(customItem.cost || customItem.price || 0),
            available: customItem.available !== undefined ? !!customItem.available : true,
            image: customItem.image || "",
            translations: translations,
            updatedAt: new Date().toISOString(),
          },
          $setOnInsert: { createdAt: new Date().toISOString() },
        },
        { upsert: true }
      );
      migratedMenu++;
    }
  }
  console.log(`✓ Menu Items collection migrated (${migratedMenu} 5-language items).`);

  // 3. Tables
  const defaultTables = (jsonData.tables && jsonData.tables.length > 0)
    ? jsonData.tables
    : [{ number: "1" }, { number: "2" }, { number: "3" }, { number: "4" }, { number: "5" }];

  for (const t of defaultTables) {
    await collections.tables.updateOne(
      { number: String(t.number) },
      { $setOnInsert: { number: String(t.number) } },
      { upsert: true }
    );
  }
  console.log(`✓ Tables collection verified.`);

  console.log("\n==========================================================");
  console.log(" 🎉 MIGRATION COMPLETE: MONGODB IS FULLY INITIALIZED!");
  console.log("==========================================================\n");

  await closeDB();
}

if (require.main === module) {
  runMigration().catch((err) => {
    console.error("❌ Migration failed with error:", err);
    process.exit(1);
  });
}

module.exports = { runMigration };