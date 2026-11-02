import { buildApp } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const host = process.env.HOST ?? "0.0.0.0";

const app = buildApp();

await app.listen({ port, host });
app.log.info({ port, host }, "farside backend listening");
