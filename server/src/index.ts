import { createWatchPartyServer } from "./watchPartyServer";

const port = Number(process.env.PORT || 4000);
const { httpServer } = createWatchPartyServer();
httpServer.listen(port, () => console.log(`Watch Party server listening on http://localhost:${port}`));
