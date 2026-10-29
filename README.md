# Jigsaw Hunt

Game web của Falcon, khung chuẩn: Vite + TypeScript + `@falcongames/game-client-sdk`.

```bash
npm install
npm run dev      # hoặc mở Preview trong Falcon IDE
npm run build    # dist/index.html — một tệp duy nhất
```

- `src/game.ts` thực hiện hợp đồng `FalconGame`; `registerFalconGame` (trong `src/falcon-game.ts`)
  tự nối phần LUÔN BẬT của SDK: bridge với shell app, save (`userData`) và analytics `log_level`.
- Các tính năng tuỳ chọn (quảng cáo, shop/IAP, lives, remove-ads, booster) KHÔNG dựng sẵn: khi cần, game tự
  làm UI theo design riêng và gọi SDK (`SDK.ads.*`, `SDK.shop.*`, …). Xem `CLAUDE.md` — file đó hướng dẫn
  AI làm đúng cách khi bạn nhờ nó viết.
- Lúc Submit, công tắc shop/ads trên CMS quyết định module nào bật trong bản phát hành; IDE kiểm chứng
  bản build trong trình duyệt thật trước khi gửi.
- `gameId` của SDK KHÔNG nằm trong source: lúc Publish, Falcon IDE đặt nó bằng **package name** của game
  (`VITE_FALCON_GAME_ID`). Lúc develop nó là `dev`.
- Số liệu của lớp studio (coin thắng, giá hồi sinh, cổng ads, lives…) đặt trong `.falcon/sdk-config.json`.

## Chơi & tải

- **Web (máy tính + điện thoại):** https://anhlh-go.github.io/Crab-Mosaic-Color-Sort/
- **APK Android:** https://github.com/anhlh-GO/Crab-Mosaic-Color-Sort/releases/latest/download/CrabMosaicColorSort.apk

Mỗi lần push lên `main`, GitHub Actions tự build lại cả hai (`.github/workflows/web.yml`, `android.yml`).
Bản web/APK build với `VITE_STANDALONE=1` nên tự vẽ thanh booster và popup thắng/thua; bản publish qua Falcon IDE
không đặt cờ này, lớp studio lo phần đó.
