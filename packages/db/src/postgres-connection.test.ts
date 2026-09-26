import { expect, it } from "vitest";
import { connectPostgres } from "./postgres-connection.js";

it("uses a Unix socket rather than TCP for libpq host URIs", async () => {
  const client = connectPostgres("postgresql://runtime@localhost:5433/example?host=/run/postgresql");
  try {
    expect(client.options.host).toEqual(["/run/postgresql"]);
    expect(client.options.path).toBe("/run/postgresql/.s.PGSQL.5433");
    expect(client.options.connection).not.toHaveProperty("host");
  } finally { await client.end(); }
});
