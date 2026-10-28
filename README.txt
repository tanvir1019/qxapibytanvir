QUOTEX CLOUDFLARE WORKER & SYNC SETUP
-------------------------------------
1. GitHub Repo-te upload korar jonno:
   - `index.js`
   - `wrangler.toml`

2. Cloudflare Dashboard Setup:
   - D1 Database banan ("quotex-db")
   - Database ID-ti `wrangler.toml` file-e `YOUR_D1_DATABASE_ID_HERE` er jaygay boshan.
   - Workers & Pages -> Connect GitHub -> repo select kore Deploy korun.

3. Sync script run korar jonno:
   - `sync.py` file-e `CF_URL` e apnar Cloudflare worker link boshan.
   - `python sync.py` chalan.
