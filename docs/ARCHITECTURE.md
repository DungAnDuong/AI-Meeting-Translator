# Kiến trúc và phân tích kỹ thuật

Tài liệu Giai đoạn 1 (phân tích & thiết kế) của AI Meeting Translator: yêu cầu nào khả thi, chọn dịch vụ nào, vì sao, và những giới hạn còn lại.

## 1. Luồng xử lý

```
Trình duyệt                                   Máy chủ (Fastify)                         Nhà cung cấp AI
───────────                                   ─────────────────                         ───────────────
getUserMedia / getDisplayMedia
  → AudioWorklet: trộn mono, hạ mẫu 16 kHz,
    VAD chia lượt nói (≤ 14 s/đoạn)
  → hàng đợi chờ xác nhận (chunkId UUID)  ──WS nhị phân──▶  MeetingSession
                                                             ├ chống trùng (audio_chunks.id)
                                                             ├ tạo đoạn tạm "Đang nhận dạng" ──▶ STT (stream delta)
◀── segment (interim, cùng ID) ────────────────────────────┤                                  ◀──
                                                             ├ Diarization → A/B/C | null
                                                             ├ tách/gộp lượt theo người nói
◀── segment "Đang dịch" + bản dịch tạm ─────────────────────┤ Translation (ngữ cảnh N câu) ──▶ LLM (stream)
◀── segment "Đã xác nhận" ─────────────────────────────────┘ lưu SQLite ở mỗi bước
```

- Văn bản và bản dịch được **cập nhật trên cùng một ID** (tạm thời → xác nhận), nên giao diện không tạo bản ghi trùng.
- Âm thanh chỉ gửi **một lần cho mỗi đoạn**; không bao giờ gửi lại cả cuộc họp. Dịch chỉ gửi câu hiện tại + vài câu ngữ cảnh, không dịch lại transcript cũ.
- Mỗi cuộc họp là một `MeetingSession` độc lập: hàng đợi, giới hạn đồng thời (`Limiter`), thống kê độ trễ, danh sách client WebSocket riêng → nhiều cuộc họp chạy song song.

## 2. Cấu trúc mã nguồn

```
shared/src            Kiểu dữ liệu, giao thức WebSocket, ngôn ngữ, định dạng thời gian
server/src
  config.ts           Biến môi trường, APP_SECRET
  database/           node:sqlite, migration đánh số
  authentication/     Tài khoản (scrypt), phiên cookie
  settings/           Cấu hình AI theo người dùng, mã hóa API key (AES-256-GCM)
  ai-provider-manager/ Interface, factory, phân loại lỗi, retry/timeout/limiter, kiểm tra kết nối
  speech-recognition/ OpenAI STT, Local STT (OpenAI-compatible, whisper.cpp)
  speaker-diarization/ OpenAI + mẫu giọng tham chiếu, theo nguồn âm thanh, không phân biệt
  translation-engine/ Prompt dịch, adapter OpenAI-compatible (OpenAI & Local), Claude
  transcript-manager/ Repository Meeting – Speaker – AudioChunk – TranscriptSegment
  meeting-session/    Pipeline thời gian thực, quản lý phiên, demo, chính sách lưu trữ
  meeting-summary/    Tổng hợp biên bản (map-reduce khi transcript dài)
  export-manager/     TXT, Markdown, DOCX, SRT, JSON
  routes/             REST + WebSocket
web/src
  audio/              AudioWorklet, VAD, thu âm micro/tab
  lib/                REST client, kết nối WebSocket (tự kết nối lại, hàng đợi gửi lại)
  store/              Zustand: trạng thái cuộc họp, đăng nhập
  components/, pages/ Giao diện
```

Interface chính (`server/src/ai-provider-manager/types.ts`): `ITranscriptionProvider`, `ITranslationProvider`, `ISpeakerDiarizationProvider`. Thêm nhà cung cấp mới = viết một lớp triển khai interface + đăng ký trong `registry.ts`.

## 3. Cơ sở dữ liệu (SQLite)

| Bảng | Nội dung |
|---|---|
| `users`, `sessions` | Tài khoản, phiên đăng nhập (lưu hash token) |
| `user_settings` | Cấu hình AI (JSON) + API key mã hóa |
| `meetings` | ID, tên, ngữ cảnh, thuật ngữ, ngôn ngữ nguồn/đích, trạng thái, nhà cung cấp, chế độ diarization, lưu âm thanh, demo, thời gian bắt đầu/kết thúc, báo cáo |
| `speakers` | Nhãn A/B/C theo thứ tự phát hiện, tên thật, màu, nguồn âm thanh (chế độ per-source) |
| `audio_chunks` | ID do client tạo (khóa chống trùng), thời điểm, trạng thái xử lý, đường dẫn file (nếu lưu) |
| `transcript_segments` | Văn bản gốc/dịch, người nói, thời điểm bắt đầu/kết thúc, ngôn ngữ, trạng thái, lỗi, cờ đã sửa tay, nói chồng, độ trễ |

Quan hệ: Meeting 1–n Speaker, Meeting 1–n AudioChunk 1–n TranscriptSegment, Speaker 1–n TranscriptSegment (`ON DELETE SET NULL` → “Không xác định”). Đổi tên người nói chỉ cập nhật một dòng `speakers`, mọi lượt liên quan tự hiển thị tên mới. Chế độ WAL, ghi ngay ở mỗi bước (không chờ kết thúc cuộc họp). Khi máy chủ khởi động lại, đoạn đang xử lý dở được đánh dấu lỗi rõ ràng (đoạn đã có văn bản gốc có thể dịch lại).

## 4. Đánh giá dịch vụ

### Speech-to-Text

| Lựa chọn | Streaming | Diarization | Ghi chú | Dùng? |
|---|---|---|---|---|
| OpenAI `gpt-4o-transcribe` / `-mini` | Văn bản trả về dạng stream trong khi xử lý một đoạn | Không | Chất lượng tốt, hỗ trợ `prompt` nối ngữ cảnh | ✔ mặc định |
| OpenAI `gpt-transcribe` | Có | Không | Trả ngôn ngữ phát hiện được, nhận `keywords` | ✔ |
| OpenAI `whisper-1` | Không | Không | Trả ngôn ngữ (verbose_json) | ✔ |
| OpenAI `gpt-4o-transcribe-diarize` | Không dùng | Có (A/B… trong *một* yêu cầu; tối đa 4 mẫu giọng tham chiếu) | Không nhận `prompt` | ✔ khi bật diarization OpenAI |
| OpenAI Realtime API | Có (trong lúc đang nói) | Không | Kết nối WebSocket liên tục, chi phí và độ phức tạp cao hơn | Kế hoạch |
| Web Speech API của trình duyệt | Có | Không | Hành vi khác nhau giữa trình duyệt (Chrome gửi âm thanh lên máy chủ Google, Firefox không hỗ trợ), không kiểm soát được model/quyền riêng tư | ✘ |
| Local: Speaches/faster-whisper, whisper.cpp | Không (theo đoạn) | Không | Cần GPU/CPU mạnh, tải model trước | ✔ |
| Anthropic Claude | — | — | Không có API nhận dạng giọng nói | ✘ |

**Lựa chọn MVP:** VAD phía trình duyệt cắt từng lượt nói (thường 1–14 giây) → gửi một lần → STT trả stream. Cách này chạy được với mọi nhà cung cấp dạng “file”, chi phí thấp (không gửi im lặng), và chữ xuất hiện khoảng 1–2 giây sau khi người nói dứt câu (tùy mạng/model). Đánh đổi: chữ chưa xuất hiện *trong khi* người nói đang nói một câu dài – giải pháp tương lai là Realtime API.

### Phân biệt người nói

Không phải dịch vụ STT nào cũng có diarization thời gian thực, nên ứng dụng có lớp `ISpeakerDiarizationProvider` riêng:

1. **OpenAI (`gpt-4o-transcribe-diarize`)**: model chỉ gán nhãn trong phạm vi một yêu cầu. Để nhãn nhất quán suốt cuộc họp, server giữ một mẫu giọng 2–10 giây cho mỗi người đã phát hiện và gửi kèm (`known_speaker_references`, tối đa 4 người gần nhất). Giọng mới chỉ được tạo người nói mới khi đủ dài (≥ 2 giây); nếu không → “Không xác định”. Xử lý STT tuần tự trong chế độ này để thứ tự nhãn A/B/C ổn định. Mẫu giọng chỉ giữ trong bộ nhớ (không lưu đĩa).
2. **Theo nguồn âm thanh**: mỗi micro/thiết bị/tab là một người nói – chính xác khi mỗi người có micro riêng hoặc tham gia bằng thiết bị riêng (mở cùng cuộc họp trên nhiều thiết bị cùng tài khoản).
3. **Không phân biệt**: mọi lượt là “Không xác định”.

Nói chồng: khi model trả về các đoạn của người khác nhau chồng lấn thời gian, cả hai lượt được đánh dấu “Nói chồng”; hai người nói không bao giờ bị gộp thành một câu.

### Dịch thuật

OpenAI Chat Completions, Claude Messages API (`output_config.effort`, server-side fallbacks khi model hỗ trợ), hoặc LLM local tương thích OpenAI. Prompt hệ thống ổn định cho cả cuộc họp (ngữ cảnh + thuật ngữ, tận dụng prompt caching), tin nhắn người dùng chỉ gồm câu hiện tại và vài câu trước làm ngữ cảnh. Quy tắc: không thêm/bớt ý, giữ nguyên mã thiết bị, số hiệu bản vẽ, đơn vị, thông số, tên riêng, thuật ngữ viết tắt; câu đã là tiếng Việt được giữ nguyên và **không gọi AI**.

## 5. Độ tin cậy

| Tình huống | Xử lý |
|---|---|
| Mạng rớt | Client giữ tối đa 150 đoạn chưa xác nhận, tự kết nối lại (backoff tới 10 s), gửi lại; server bỏ qua đoạn trùng ID |
| Dịch vụ AI lỗi tạm thời (429, 5xx, timeout) | Thử lại có giới hạn (mặc định 2 lần, backoff, tôn trọng `retry-after`), timeout mỗi lần |
| Lỗi cố định (sai key, hết hạn mức, model không hỗ trợ) | Không thử lại; trạng thái AI “Lỗi” + thông báo tiếng Việt + hướng dẫn |
| Đoạn lỗi | Hiển thị lỗi tại lượt đó, nút *Thử lại* (nhận dạng lại từ âm thanh còn giữ tạm, hoặc dịch lại), *Tự nhập bản dịch* |
| Kết thúc khi còn việc | Hỏi người dùng: chờ xử lý xong hoặc hủy (đoạn bị hủy được đánh dấu) |
| Tải lại trang | Nội dung đã lưu được tải lại qua snapshot; thu âm cần bấm lại (trình duyệt yêu cầu thao tác người dùng) |
| Máy chủ khởi động lại | Đoạn đang xử lý được đánh dấu lỗi, có thể dịch lại |

## 6. Giới hạn hiện tại (cần biết khi sử dụng)

- Chữ xuất hiện sau khi người nói ngừng ~0,65 s (hoặc tối đa ~14 s với câu rất dài), không phải từng từ trong lúc nói. Độ trễ thực tế phụ thuộc nguồn âm thanh, mạng, model và nhà cung cấp – không có cam kết cố định.
- Một micro chung cho cả phòng: phân biệt người nói có thể nhầm (nhất là giọng giống nhau, khoảng cách xa micro, > 4 người cùng hoạt động). Dùng “Gộp người nói” / đổi người nói từng lượt để sửa.
- VAD dựa trên năng lượng: môi trường rất ồn có thể cắt câu chưa chuẩn.
- Âm thanh tab chỉ có trên Chrome/Edge máy tính; ứng dụng web không lấy được âm thanh từ ứng dụng Zoom/Teams cài trên máy (trừ chia sẻ âm thanh hệ thống toàn màn hình trên Windows). Điện thoại chỉ dùng micro.
- Hàng đợi âm thanh chưa gửi nằm trong bộ nhớ trình duyệt – mất nếu tải lại trang *khi đang mất mạng*.
- Tự nhận dạng ngôn ngữ: chỉ `gpt-transcribe`, `whisper-1` và Local STT trả về ngôn ngữ; với model khác, ứng dụng nhận dạng theo chữ viết (tiếng Việt/CJK/Thái/Cyrillic) và để LLM tự xác định ngôn ngữ nguồn khi dịch.
- `node:sqlite` được Node.js đánh dấu “experimental” (in cảnh báo khi khởi động) dù đã ổn định cho mục đích này.
- Các adapter AI được kiểm thử với máy chủ giả lập theo đặc tả API; cần xác nhận với key thật trước khi dùng chính thức.
