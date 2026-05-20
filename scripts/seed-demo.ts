import { mkdir } from "node:fs/promises";
import path from "node:path";

await mkdir(path.resolve(process.cwd(), "data"), { recursive: true });
process.stdout.write("Demo data directory is ready.\n");
