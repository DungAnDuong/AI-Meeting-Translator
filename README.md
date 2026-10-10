# AI Meeting Translator

Ứng dụng web phiên dịch cuộc họp theo thời gian thực: thu âm (micro hoặc âm thanh tab cuộc họp online) → nhận dạng giọng nói → phân biệt người nói → dịch sang tiếng Việt → hiển thị liên tục → lưu tự động → tổng hợp biên bản và xuất file.

- **Frontend:** React 19 + TypeScript + Vite + Tailwind CSS 4 (mobile-first, có dark mode).
- **Backend:** Node.js + TypeScript + Fastify + WebSocket.
- **Lưu trữ:** SQLite qua module có sẵn `node:sqlite` của Node.js (không cần máy chủ CSDL, dữ liệu nằm trong 1 file).
- **AI:** OpenAI (Speech-to-Text, phân biệt người nói, dịch), Anthropic Claude (dịch, tóm tắt), Local AI (STT và LLM chạy trên máy chủ riêng). Kiến trúc adapter nên có thể đổi nhà cung cấp mà không phải viết lại ứng dụng.

Phân tích kiến trúc, đánh giá nhà cung cấp và các giới hạn kỹ thuật: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## 1. Cài đặt và chạy

Yêu cầu: **Node.js ≥ 22.13** (đã kiểm thử với Node 24). Không cần Docker hay máy chủ cơ sở dữ liệu.

```bash
npm install
cp .env.example server/.env      # Windows: copy .env.example server\.env
```

### Chạy nhanh trên Windows (click đúp)

- **Start.bat** – lần đầu tự cài thư viện, build giao diện, chạy server **ẩn** (không có cửa sổ) tại http://localhost:5555, tự mở trình duyệt khi server sẵn sàng rồi tự đóng cửa sổ cmd. Nếu server đã chạy sẵn thì chỉ mở trình duyệt. Log server ghi vào `logs\server.log` và `logs\server-error.log`.
- **Stop.bat** – dừng server đang chạy trên port 5555.

### Chạy khi phát triển

```bash
npm run dev
```

- Giao diện: http://localhost:5173 (Vite, tự proxy `/api` và `/ws` sang backend)
- Backend: http://localhost:8787

### Chạy production

```bash
npm run build      # build giao diện vào web/dist
npm start          # backend phục vụ cả API, WebSocket và giao diện tại PORT (mặc định 8787)
```

Ứng dụng không có màn hình đăng nhập: mọi yêu cầu dùng chung một tài khoản local (tài khoản tạo sớm nhất trong DB, hoặc tự tạo `local@localhost`). Chỉ chạy trên máy cá nhân / mạng tin cậy.

> Trình duyệt chỉ cho thu âm trên **HTTPS** hoặc `http://localhost`. Khi truy cập từ điện thoại/máy khác, bạn cần HTTPS (xem mục Triển khai).

### Thử nhanh không cần API Key

Ở Trang chủ bấm **“Thử chế độ Demo”**. Chế độ này phát lại một transcript **mẫu** (gắn nhãn `[DEMO]` ở mọi nơi, kể cả file xuất) để làm quen giao diện, đổi tên người nói, xuất file, xem biên bản. Demo **không** thu âm và **không** gọi dịch vụ AI, nên không phải phiên dịch thật.

---

## 2. Cấu hình nhà cung cấp AI

Mở **Cài đặt** (biểu tượng bánh răng). Mỗi chức năng có thể chọn nhà cung cấp riêng:

| Chức năng | Lựa chọn |
|---|---|
| Speech-to-Text | OpenAI · Local AI |
| Phân biệt người nói | OpenAI (theo giọng nói) · Theo nguồn âm thanh · Không phân biệt |
| Dịch thuật | OpenAI · Anthropic Claude · Local AI |
| Tóm tắt biên bản | Dùng nhà cung cấp Dịch thuật đang chọn |

API Key được gửi lên backend, **mã hóa AES-256-GCM** trong DB và không bao giờ gửi lại trình duyệt (giao diện chỉ hiển thị dạng `sk-p••••abcd`). Không có key nào nằm trong mã frontend hay `localStorage`.

Sau khi lưu, bấm **“Kiểm tra kết nối”** ở từng mục, hoặc **“Kiểm tra toàn bộ cấu hình”** (gửi 1 giây âm thanh mẫu và dịch thử 1 câu bằng cấu hình đang chọn – có thể phát sinh chi phí rất nhỏ).

### OpenAI (cấu hình khuyến nghị để bắt đầu)

1. Tạo API key tại https://platform.openai.com/api-keys và bảo đảm tài khoản có hạn mức.
2. Cài đặt → OpenAI → nhập API Key → Lưu.
3. Chức năng: Speech-to-Text = OpenAI, Phân biệt người nói = OpenAI, Dịch thuật = OpenAI → Kiểm tra toàn bộ cấu hình.

| Model STT | Văn bản tạm thời (streaming) | Phân biệt người nói | Trả về ngôn ngữ |
|---|---|---|---|
| `gpt-4o-transcribe` (mặc định) | Có | Không | Không |
| `gpt-4o-mini-transcribe` | Có | Không | Không |
| `gpt-transcribe` | Có | Không | Có |
| `whisper-1` | Không | Không | Có |
| `gpt-4o-transcribe-diarize` | Không (ứng dụng gọi dạng thường) | Có | Không |

Khi chọn “Phân biệt người nói = OpenAI”, hệ thống tự dùng `gpt-4o-transcribe-diarize` cho STT. Model dịch mặc định là `gpt-4.1-mini` (nhanh); có thể đổi sang model chat khác. Có thể đổi **Endpoint** nếu dùng gateway tương thích API OpenAI.

### Anthropic Claude

Claude được dùng làm **bộ máy dịch và tổng hợp biên bản**. Claude API không thu âm, không nhận dạng giọng nói và không phân biệt người nói – các phần đó vẫn cần OpenAI hoặc Local STT.

1. Tạo key tại https://console.anthropic.com → Cài đặt → Anthropic Claude → nhập key.
2. Model mặc định `claude-opus-5-5`; có thể đổi sang `claude-sonnet-5-5` / `claude-haiku-5-5` để nhanh và rẻ hơn khi dịch từng câu.
3. “Mức nỗ lực”: để **Thấp** cho dịch thời gian thực (tóm tắt tự dùng tối thiểu mức Trung bình).
4. Tùy chọn “Tự chuyển sang model dự phòng khi model từ chối xử lý” (server-side fallbacks) bật sẵn cho các model hỗ trợ.
5. Chức năng: Dịch thuật = Anthropic Claude.

### Local AI

Local AI là một **cách triển khai riêng** (model chạy trên máy chủ của bạn), không phải nhà cung cấp đám mây. Máy chủ cần đủ GPU/RAM và phải **tải model trước** khi dùng. Hai chức năng cấu hình riêng:

**Whisper cài sẵn (khuyến nghị trên Windows)** – `tools\install-whisper.ps1` cài whisper.cpp v1.9.5 (bản CUDA nếu có GPU NVIDIA, kèm thư viện cuBLAS chính thức của NVIDIA; ngược lại bản CPU) và model `ggml-small` (thêm `-Turbo` để tải `large-v3-turbo`), mọi file đều kiểm tra SHA-256:

```powershell
powershell -ExecutionPolicy Bypass -File tools\install-whisper.ps1
```

`Start.bat` tự chạy Whisper ẩn tại `http://127.0.0.1:8178` (log ở `logs\whisper.log`), `Stop.bat` dừng cả hai. Trong Cài đặt: Speech-to-Text = **Local AI**, Kiểu API = **whisper.cpp server**, Địa chỉ = `http://127.0.0.1:8178`, Phân biệt người nói = *Theo nguồn âm thanh* hoặc *Không phân biệt*. Đổi model bằng biến `WHISPER_MODEL` ở đầu `Start.bat`.

Đo trên GTX 1650 Ti (4 GB), model `small`: ~1,1 s cho mỗi câu khi chọn sẵn ngôn ngữ đầu vào, ~2,3 s khi để *Tự động nhận dạng* (phải phát hiện ngôn ngữ trước). `large-v3-turbo` chính xác hơn với giọng khó/ồn nhưng ~3,5 s mỗi câu. Lần chạy đầu tiên sau khi cài, driver NVIDIA biên dịch kernel CUDA mất khoảng 1–2 phút (chỉ một lần).

**Local Speech-to-Text khác** – một trong hai kiểu:
- *Tương thích OpenAI* (`/v1/audio/transcriptions`), ví dụ [Speaches / faster-whisper-server](https://github.com/speaches-ai/speaches):
  ```bash
  docker run --gpus=all -p 8000:8000 ghcr.io/speaches-ai/speaches:latest-cuda
  # Địa chỉ: http://localhost:8000/v1   Model: Systran/faster-whisper-small (hoặc large-v3)
  ```
- *whisper.cpp server* (`/inference`): `./build/bin/whisper-server -m models/ggml-base.bin --port 8080` → Địa chỉ `http://localhost:8080`.

**Local Translation LLM** – bất kỳ máy chủ tương thích OpenAI Chat Completions:
```bash
ollama pull qwen2.5:7b-instruct      # tải model trước
ollama serve                         # Endpoint: http://localhost:11434/v1
```
LM Studio: `http://localhost:1234/v1`; vLLM / llama.cpp server cũng dùng được. Nút “Kiểm tra Local LLM” báo rõ nếu model chưa được tải.

Lưu ý quyền riêng tư: dữ liệu được xử lý **trên máy có địa chỉ bạn nhập**. Nếu đó là một máy khác trong mạng, âm thanh/văn bản sẽ đi qua mạng tới máy đó. Dùng Local AI không có nghĩa toàn bộ hệ thống chạy offline (trình duyệt vẫn kết nối tới máy chủ ứng dụng). Local STT hiện **không** có phân biệt người nói theo giọng – dùng chế độ “Theo nguồn âm thanh”.

### Thuật ngữ chuyên ngành và ngữ cảnh

- **Cài đặt → Thuật ngữ chuyên ngành**: mỗi dòng `thuật ngữ gốc = cách dịch` (có sẵn danh sách điện/tự động hóa: PLC, HMI, SCADA, BOM, CAD, cable tray = máng cáp, control panel = tủ điều khiển…).
- **Ngữ cảnh cuộc họp** (khi tạo cuộc họp hoặc panel “Ngữ cảnh”): lĩnh vực, dự án, tên riêng… Mỗi cuộc họp có thể bổ sung thuật ngữ riêng.

---

## 3. Sử dụng

1. Trang chủ → nhập tên cuộc họp, ngôn ngữ đầu vào (hoặc *Tự động nhận dạng*), ngữ cảnh → **Tạo cuộc họp**.
2. Chọn **nguồn âm thanh**:
   - *Micro của thiết bị* – họp trực tiếp, hoặc chọn thiết bị đầu vào khác.
   - *Âm thanh tab / hệ thống* – họp online trên trình duyệt (Google Meet, Teams web, Zoom web): chọn đúng tab và bật **“Chia sẻ âm thanh tab”**. Chỉ Chrome/Edge trên máy tính.
   - *Micro + âm thanh tab* – thu cả giọng bạn và người khác (nên đeo tai nghe để tránh trùng tiếng).
3. **Bắt đầu phiên dịch** → đọc thông báo quyền riêng tư (âm thanh/văn bản được gửi tới nhà cung cấp nào) → cho phép micro.
4. Trong lúc họp: **Tạm dừng / Tiếp tục / Tắt micro**, xem trạng thái (Đang chờ · Đang nghe · Đang nhận dạng · Đang dịch · Mất kết nối · Đã tạm dừng), tìm kiếm, sửa văn bản, đổi người nói của từng lượt, sao chép, chế độ *Chỉ tiếng Việt*, chỉnh cỡ chữ.
5. **Kết thúc**: phần đang nói dở được gửi đi; nếu còn đoạn đang xử lý, ứng dụng hỏi *Chờ xử lý xong* hay *Kết thúc ngay (hủy các đoạn chưa xong)*.
6. Sau họp: đổi tên Speaker A/B… thành tên thật (áp dụng toàn bộ bản ghi), gộp người nói bị tách nhầm, tab **Biên bản AI** để tạo – chỉnh sửa – xuất báo cáo, **Xuất biên bản** (TXT UTF-8, Word, Markdown, SRT, JSON; song ngữ hoặc chỉ tiếng Việt).

Tải lại trang hoặc mở lại từ **Lịch sử** sẽ phục hồi toàn bộ nội dung đã lưu; bấm *Tiếp tục thu âm* để ghi tiếp.

---

## 4. Kiểm thử

```bash
npm test            # 57 test: backend (Vitest) + VAD phía trình duyệt
npm run typecheck
npm run test:e2e    # kiểm thử trình duyệt thật (Chrome/Edge headless) – xem bên dưới
```

- **Backend** (`server/test`): adapter OpenAI/Claude/Local (đối chiếu định dạng request/response với một máy chủ HTTP giả lập *chỉ dùng trong test*), phân loại lỗi (sai key, hết hạn mức, rate limit, model không tồn tại, Local AI không kết nối được), retry có giới hạn và timeout, logic phân biệt người nói (nhãn A/B nhất quán, “Không xác định” khi chưa đủ cơ sở, nói chồng), luồng WebSocket end-to-end (chống trùng đoạn gửi lại, lỗi STT → thử lại, lỗi dịch không mất văn bản gốc, kết thúc khi còn nội dung chưa xử lý, hủy), phân quyền truy cập cuộc họp, chống CSRF, API key không lộ ra ngoài, xuất TXT tiếng Việt đúng định dạng, demo.
- **Trình duyệt** (`e2e/browser-e2e.ts`): Chrome headless với **micro giả lập phát file hội thoại tiếng Anh thật** (tạo bằng Windows TTS: `npm run sample-audio`). Kiểm tra AudioWorklet + VAD tách câu, WebSocket, hiển thị, tạm dừng/tiếp tục, đổi tên người nói, giao diện 390 px không cuộn ngang, phục hồi khi tải lại, kết thúc, xuất TXT, lịch sử, demo, biên bản. Ảnh chụp lưu ở `e2e/screenshots/`. Phía AI là máy chủ giả lập nên bài này **không** đánh giá độ chính xác nhận dạng/dịch.

---

## 5. Triển khai

1. Máy chủ có Node ≥ 22.13. `npm ci && npm run build`.
2. Tạo `server/.env` từ `.env.example`: **bắt buộc** đặt `APP_SECRET` (≥ 32 ký tự), `NODE_ENV=production`; tùy chọn `RETENTION_DAYS`, `ALLOW_REGISTRATION`, key mặc định.
3. Chạy `npm start` bằng trình quản lý tiến trình (systemd, pm2, NSSM trên Windows…).
4. Đặt sau reverse proxy có **HTTPS** (bắt buộc để trình duyệt cho dùng micro) và hỗ trợ WebSocket, đặt `TRUST_PROXY=true`. Ví dụ nginx:
   ```nginx
   location / {
     proxy_pass http://127.0.0.1:8787;
     proxy_http_version 1.1;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection "upgrade";
     proxy_set_header Host $host;
     proxy_set_header X-Forwarded-Proto $scheme;
     proxy_read_timeout 3600s;
     client_max_body_size 5m;
   }
   ```
   Caddy: `meeting.example.com { reverse_proxy 127.0.0.1:8787 }` (tự cấp HTTPS, tự hỗ trợ WebSocket).
5. Sao lưu thư mục `DATA_DIR` (file `meetings.db*` và `audio/` nếu có lưu âm thanh).

---

## 6. Bảo mật và quyền riêng tư

- Chỉ thu âm sau khi người dùng bấm Bắt đầu và trình duyệt cấp quyền; chỉ báo “Đang thu” luôn hiển thị; có Tạm dừng / Tắt micro.
- Trước lần thu đầu tiên, ứng dụng liệt kê nơi âm thanh và văn bản sẽ được gửi tới.
- Âm thanh gốc **không được lưu** (chỉ giữ tạm trong bộ nhớ khi xử lý, để có thể *Thử lại* khi lỗi) – trừ khi bật “Lưu file âm thanh gốc” cho từng cuộc họp.
- Tài khoản: mật khẩu băm scrypt; phiên đăng nhập bằng cookie `httpOnly`, `SameSite=Lax` (`Secure` khi production); giới hạn số lần đăng nhập sai.
- Mỗi cuộc họp chỉ chủ sở hữu truy cập được (REST, WebSocket, xuất file). Yêu cầu thay đổi dữ liệu và WebSocket bị chặn nếu đến từ origin khác.
- API key mã hóa trong DB; log không ghi cookie/header xác thực/API key và không ghi nội dung transcript.
- Xóa cuộc họp xóa toàn bộ transcript, người nói, báo cáo và file âm thanh. `RETENTION_DAYS` tự xóa cuộc họp cũ.

---

## 7. Tình trạng tính năng

**Đã hoàn thành và đã kiểm thử**
- Tạo/bắt đầu/tạm dừng/tiếp tục/kết thúc cuộc họp; lịch sử; tìm kiếm; xóa.
- Thu âm micro / thiết bị khác / âm thanh tab / micro + tab; chỉ báo âm lượng; xử lý từ chối quyền, không có micro, micro bận, tab không có âm thanh.
- VAD trong AudioWorklet chia lượt nói, chỉ gửi từng đoạn ngắn; hàng đợi gửi lại khi mất mạng; chống xử lý trùng.
- STT OpenAI (streaming văn bản tạm thời), Local STT (OpenAI-compatible, whisper.cpp).
- Phân biệt người nói: OpenAI diarize + mẫu giọng tham chiếu để giữ nhãn nhất quán, theo nguồn âm thanh, không phân biệt; “Không xác định” khi chưa đủ cơ sở; đánh dấu nói chồng; đổi tên, gộp, gán lại người nói.
- Dịch: OpenAI, Claude, Local LLM; streaming bản dịch tạm thời; ngữ cảnh vài câu trước; thuật ngữ; giữ nguyên mã kỹ thuật.
- Timeout, retry giới hạn, giới hạn đồng thời, trạng thái AI, thông số độ trễ (nhận dạng / dịch / cập nhật giao diện).
- Lưu tự động SQLite; phục hồi sau tải lại trang hoặc khởi động lại máy chủ; phân biệt nội dung tạm thời / đã xác nhận / chờ đồng bộ.
- Xuất TXT, Markdown, DOCX, SRT, JSON; báo cáo AI có trích dẫn, chỉnh sửa trước khi xuất.
- Giao diện responsive (điện thoại/máy tính bảng/desktop), dark mode, chế độ Chỉ tiếng Việt, cỡ chữ.

**Chưa kiểm chứng với dịch vụ thật trong quá trình phát triển** – môi trường phát triển không có API key OpenAI/Anthropic hay máy chủ Local AI, nên các adapter được kiểm tra với máy chủ giả lập theo đặc tả API. Cần chạy “Kiểm tra toàn bộ cấu hình” và một cuộc họp thử với key thật trước khi dùng chính thức.

**Hướng phát triển tiếp**
- STT streaming thực sự trong lúc đang nói (OpenAI Realtime API qua WebSocket) để hiện chữ ngay khi người nói chưa dứt câu.
- Diarization chạy local (vd. dịch vụ pyannote) qua `ISpeakerDiarizationProvider`.
- Nhiều thiết bị của *nhiều tài khoản* cùng tham gia một cuộc họp (hiện các thiết bị cùng tài khoản đã tham gia được – mỗi thiết bị là một nguồn âm thanh).
- Chia sẻ cuộc họp/biên bản giữa người dùng, vai trò quản trị.
- Tích hợp chuyên biệt với nền tảng họp (bot Zoom/Teams/Meet) – kiến trúc nguồn âm thanh đã tách riêng để bổ sung.
- Lưu hàng đợi âm thanh chưa gửi vào IndexedDB để không mất khi tải lại trang lúc mất mạng.
