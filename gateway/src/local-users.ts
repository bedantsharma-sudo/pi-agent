import type { Database } from "better-sqlite3";

export type LocalRole = "submit_prds" | "admin";

export interface LocalUser {
  email: string;
  name: string;
  role: LocalRole;
  createdAt: string;
}

export interface LocalUserStore {
  getOrProvision(email: string, name: string): LocalUser;
  setRole(email: string, role: LocalRole): void;
  get(email: string): LocalUser | undefined;
  list(): LocalUser[];
  seedAdmins(emails: string[]): void;
}

interface UserRow {
  email: string;
  name: string;
  role: LocalRole;
  created_at: string;
}

function rowToUser(row: UserRow): LocalUser {
  return { email: row.email, name: row.name, role: row.role, createdAt: row.created_at };
}

export function createLocalUserStore(db: Database): LocalUserStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_users (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('submit_prds', 'admin')),
      created_at TEXT NOT NULL
    )
  `);

  const getStmt = db.prepare<[string], UserRow>("SELECT * FROM local_users WHERE email = ?");
  const insertStmt = db.prepare(
    "INSERT INTO local_users (email, name, role, created_at) VALUES (@email, @name, @role, @createdAt)",
  );
  const updateRoleStmt = db.prepare("UPDATE local_users SET role = ? WHERE email = ?");
  const listStmt = db.prepare<[], UserRow>("SELECT * FROM local_users ORDER BY email");

  function get(email: string): LocalUser | undefined {
    const row = getStmt.get(email);
    return row ? rowToUser(row) : undefined;
  }

  return {
    get,

    getOrProvision(email: string, name: string): LocalUser {
      const existing = get(email);
      if (existing) return existing;
      insertStmt.run({ email, name, role: "submit_prds", createdAt: new Date().toISOString() });
      return get(email)!;
    },

    setRole(email: string, role: LocalRole): void {
      const result = updateRoleStmt.run(role, email);
      if (result.changes === 0) {
        throw new Error(`Cannot set role — no local user provisioned for ${email}`);
      }
    },

    list(): LocalUser[] {
      return listStmt.all().map(rowToUser);
    },

    seedAdmins(emails: string[]): void {
      for (const email of emails) {
        const existing = get(email);
        if (existing) {
          updateRoleStmt.run("admin", email);
        } else {
          insertStmt.run({ email, name: email, role: "admin", createdAt: new Date().toISOString() });
        }
      }
    },
  };
}
