---
'nostream': patch
---

fix(cli): keep the .env file private to its owner

`nostream setup` and `nostream config env set` wrote `.env` with the default file mode, which under the usual umask makes it readable by every local account that can reach the project directory. The file holds `SECRET`, which signs the admin session tokens, and other credentials. The CLI now creates `.env` readable by its owner only (mode 0600), including when it starts from `.env.example`, and restricts an existing `.env` to the owner whenever it writes to it. An existing `.env` that setup does not need to change is left as it is. Where the permissions cannot be changed, for example on a file system without Unix permissions, the write still succeeds.
