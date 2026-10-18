# Admin console screenshots

Source stills for the operator-console film (`website/hero-animation/src/admin-film.ts`). After replacing one, re-render the film and publish site media (Workers preview deploy requires every asset under 25 MiB — `pnpm run media` re-encodes the mp4 for `public/`).

```bash
cd website/hero-animation
pnpm run render:admin && pnpm run frames:admin   # → output/admin/nostream-admin.mp4 (+ frames/)
cd ../site
pnpm run media                                   # → public/media/admin.mp4, admin-poster.webp
```

| File | Scene |
|------|-------|
| `metrices.png` | Live metrics |
| `nip66.png` | Network health (NIP-66) |
| `settings-editor.png` | Settings editor |
| `notification.png` | Notifications |
