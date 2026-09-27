import { createApplication } from "./app.js";

const service = createApplication();
const port = Number(process.env.PORT || 3001);
service.http.listen(port, process.env.HOST || "127.0.0.1", () => {
  console.log(`Still server listening on port ${port}`);
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  await service.close();
  clearTimeout(timeout);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
