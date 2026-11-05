import { app } from './app.js';
import { client, crearIndices } from './db.js';

await client.connect();
await crearIndices();
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`API del banco en http://localhost:${port}`));
