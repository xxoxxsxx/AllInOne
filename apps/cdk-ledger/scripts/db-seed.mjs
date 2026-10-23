import { createClient, readSqlFiles } from "./db-utils.mjs";

async function main() {
  const client = createClient();
  const files = readSqlFiles("db/seeds");

  await client.connect();

  try {
    for (const file of files) {
      process.stdout.write(`Applying seed ${file.name}...\n`);
      await client.query(file.sql);
    }
  } finally {
    await client.end();
  }

  process.stdout.write("Seeds complete.\n");
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
