/**
 * KIỂM THỬ TRÌNH DUYỆT END-TO-END (không dùng trong ứng dụng).
 *
 * Chrome thật (headless) dùng micro giả lập phát file hội thoại tiếng Anh (e2e/fixtures/meeting-sample.wav,
 * tạo bằng e2e/make-sample-audio.ps1). Luồng kiểm tra: AudioWorklet + VAD chia câu từ âm thanh thật →
 * WebSocket → server → provider (máy chủ mock tương thích OpenAI chạy cục bộ) → giao diện → kết thúc → xuất TXT.
 * Lưu ý: mock trả transcript cố định nên bài này KHÔNG đánh giá độ chính xác nhận dạng giọng nói.
 *
 * Chạy:  npm run build && npx tsx e2e/browser-e2e.ts
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { buildApp } from '../server/src/app';
import { loadConfig } from '../server/src/config';
import { startMockAiServer } from '../server/test/helpers/mock-ai-server';

const root = path.resolve(import.meta.dirname, '..');
const wav = path.join(root, 'e2e', 'fixtures', 'meeting-sample.wav');
const shotsDir = path.join(root, 'e2e', 'screenshots');
/** Đặt E2E_WHISPER_URL (vd. http://127.0.0.1:8178) để nhận dạng bằng Whisper thật thay vì mock. */
const WHISPER_URL = process.env.E2E_WHISPER_URL;
/** Văn bản chờ xuất hiện: bản dịch (mock) hoặc văn bản gốc do Whisper thật nhận dạng. */
const expect3 = (en: string) => (WHISPER_URL ? new RegExp(en.split(' ').slice(-4).join(' ').replace(/[.?]/g, '')) : LINES[en]);
const CHROME = process.env.CHROME_PATH ?? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));

const LINES: Record<string, string> = {
  'We need to finish the electrical design before Friday.': 'Chúng ta cần hoàn thành thiết kế điện trước thứ Sáu.',
  'I agree. We also need to check the cable tray dimensions.': 'Tôi đồng ý. Chúng ta cũng cần kiểm tra kích thước máng cáp.',
  'Can you send the updated drawings tomorrow?': 'Bạn có thể gửi bản vẽ đã cập nhật vào ngày mai không?',
};

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error(`KIỂM THỬ THẤT BẠI: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  if (!fs.existsSync(wav)) throw new Error('Thiếu file âm thanh mẫu – chạy e2e/make-sample-audio.ps1 trước');
  if (!CHROME) throw new Error('Không tìm thấy Chrome/Edge – đặt CHROME_PATH');
  fs.mkdirSync(shotsDir, { recursive: true });

  const mock = await startMockAiServer();
  mock.state.transcriptQueue = [...Object.keys(LINES), ...Object.keys(LINES)];
  mock.state.translations = LINES;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amt-e2e-'));
  process.env.ALLOW_REGISTRATION = 'true';
  const config = loadConfig({ dataDir, secretKey: crypto.randomBytes(32), webDistDir: path.join(root, 'web', 'dist') });
  const { app } = await buildApp(config, { logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  console.log(`Máy chủ thử nghiệm: ${base}`);

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const errors: string[] = [];
  const watch = (p: Page) => {
    p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    p.on('pageerror', (e) => errors.push(String(e)));
  };

  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 }, permissions: ['microphone'] });
    const page = await ctx.newPage();
    watch(page);

    console.log('1. Mở ứng dụng (không cần đăng nhập)');
    await page.goto(base);
    await page.getByRole('heading', { name: 'Cuộc họp mới' }).waitFor();
    check(true, 'Vào thẳng trang chủ');

    console.log('2. Cấu hình AI (Local → máy chủ mock) qua trang Cài đặt');
    await page.getByRole('link', { name: 'Cài đặt AI', exact: true }).click();
    await page.getByRole('heading', { name: 'Cài đặt AI' }).waitFor();
    const res = await page.request.put(`${base}/api/settings`, {
      headers: { origin: base },
      data: {
        local: WHISPER_URL
          ? { sttBaseUrl: WHISPER_URL, sttApiStyle: 'whisper.cpp', sttModel: 'ggml-small', llmBaseUrl: `${mock.url}/v1`, llmModel: 'test-llm' }
          : { sttBaseUrl: `${mock.url}/v1`, sttApiStyle: 'openai', sttModel: 'test-stt', llmBaseUrl: `${mock.url}/v1`, llmModel: 'test-llm' },
        pipeline: { sttProvider: 'local', translationProvider: 'local', diarizationMode: 'per-source' },
      },
    });
    check(res.ok(), `Lưu cấu hình Local AI (STT: ${WHISPER_URL ? 'Whisper thật ' + WHISPER_URL : 'mock'})`);
    await page.reload();
    await page.getByRole('button', { name: 'Kiểm tra Local LLM' }).click();
    await page.getByText('model "test-llm" đã sẵn sàng').waitFor({ timeout: 10_000 });
    check(true, 'Nút "Kiểm tra kết nối" Local LLM báo thành công');
    if (WHISPER_URL) {
      await page.getByRole('button', { name: 'Kiểm tra Local STT' }).click();
      await page.getByText('Máy chủ STT nhận và xử lý được âm thanh').waitFor({ timeout: 30_000 });
      check(true, 'Nút "Kiểm tra Local STT" với Whisper thật báo thành công');
    }
    await page.screenshot({ path: path.join(shotsDir, '01-settings.png'), fullPage: false });

    console.log('3. Tạo cuộc họp và bắt đầu phiên dịch bằng micro (giả lập)');
    await page.getByRole('link', { name: 'Trang chủ' }).click();
    await page.getByLabel('Tên cuộc họp').fill('Họp dự án tủ điện');
    await page.getByLabel('Ngữ cảnh cuộc họp (không bắt buộc)').fill('Thiết kế tủ điện, máng cáp');
    await page.getByRole('button', { name: 'Tạo cuộc họp' }).click();
    await page.getByRole('button', { name: 'Bắt đầu phiên dịch' }).first().waitFor();
    await page.getByRole('button', { name: 'Bắt đầu phiên dịch' }).first().click();
    await page.getByRole('button', { name: 'Đồng ý và bắt đầu' }).click();
    await page.getByText('Đang thu', { exact: true }).waitFor({ timeout: 10_000 });
    check(true, 'Đã xin quyền & bắt đầu thu âm (chỉ báo "Đang thu" hiển thị)');

    const t0 = Date.now();
    await page.getByText(expect3('We need to finish the electrical design before Friday.')).waitFor({ timeout: 30_000 });
    console.log(`  · Câu đầu tiên hiển thị bản dịch sau ${((Date.now() - t0) / 1000).toFixed(1)} s kể từ lúc bắt đầu thu`);
    await page.getByText(expect3('I agree. We also need to check the cable tray dimensions.')).waitFor({ timeout: 30_000 });
    await page.getByText(expect3('Can you send the updated drawings tomorrow?')).waitFor({ timeout: 30_000 });
    check(true, 'VAD tách 3 câu từ âm thanh thật, mỗi câu được nhận dạng + dịch và hiển thị');
    const sttCalls = mock.state.requests.filter((r) => r.path === '/v1/audio/transcriptions');
    console.log(`  · Số đoạn âm thanh gửi STT: ${sttCalls.length}`);
    if (!WHISPER_URL) check(sttCalls.length >= 3, 'Âm thanh được chia thành từng đoạn ngắn (không gửi cả cuộc họp)');
    else check((await page.locator('article').count()) >= 3, 'Whisper thật nhận dạng đúng từng câu từ micro');
    await page.screenshot({ path: path.join(shotsDir, '02-meeting-desktop.png') });

    console.log('4. Tạm dừng / tiếp tục');
    await page.getByRole('button', { name: 'Tạm dừng' }).first().click();
    await page.getByRole('status').filter({ hasText: 'Đã tạm dừng' }).first().waitFor();
    check(true, 'Trạng thái "Đã tạm dừng" hiển thị bằng chữ + biểu tượng');
    await page.getByRole('button', { name: 'Tiếp tục' }).first().click();
    await page.getByText('Đang thu', { exact: true }).waitFor();
    check(true, 'Tiếp tục thu âm');

    console.log('5. Đổi tên người nói');
    await page.getByRole('tab', { name: 'Người nói' }).click();
    const nameInput = page.getByLabel('Tên thật của Speaker A');
    await nameInput.fill('Anh Minh');
    await nameInput.press('Enter');
    await page.getByText('Anh Minh').first().waitFor();
    check((await page.locator('article', { hasText: 'Anh Minh' }).count()) >= 1, 'Tên mới áp dụng cho các lượt phát biểu');

    console.log('6. Giao diện điện thoại (tải lại trang → phục hồi phiên)');
    const mobile = await browser.newContext({ ...{ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, storageState: await ctx.storageState() });
    const mpage = await mobile.newPage();
    watch(mpage);
    await mpage.goto(page.url());
    await mpage.getByText(expect3('Can you send the updated drawings tomorrow?')).first().waitFor();
    const overflow = await mpage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(overflow <= 0, `Không cuộn ngang trên màn hình 390px (overflow=${overflow})`);
    await mpage.screenshot({ path: path.join(shotsDir, '03-meeting-mobile.png') });
    await mpage.getByRole('button', { name: 'Song ngữ' }).click();
    await mpage.screenshot({ path: path.join(shotsDir, '04-meeting-mobile-vi-only.png') });
    await mobile.close();

    console.log('7. Kết thúc cuộc họp');
    await page.getByRole('button', { name: 'Kết thúc' }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Kết thúc' }).click();
    const endedMsg = page.getByText('Đã kết thúc cuộc họp');
    const pendingBtn = page.getByRole('button', { name: 'Chờ xử lý xong (khuyến nghị)' });
    await endedMsg.or(pendingBtn).first().waitFor({ timeout: 30_000 });
    if (await pendingBtn.isVisible()) {
      console.log('  · Còn đoạn đang xử lý → hỏi người dùng → chọn "Chờ xử lý xong"');
      await pendingBtn.click();
    }
    await endedMsg.waitFor({ timeout: 30_000 });
    check(true, 'Kết thúc cuộc họp (thu âm đã dừng, nội dung còn lại được xử lý)');
    await page.screenshot({ path: path.join(shotsDir, '05-meeting-ended.png') });

    console.log('8. Xuất TXT');
    const id = page.url().split('/').pop();
    const txt = await page.request.get(`${base}/api/meetings/${id}/export?format=txt&mode=both&tz=Asia/Ho_Chi_Minh`);
    const body = (await txt.body()).toString('utf8');
    console.log(body.split('\r\n').slice(0, 14).join('\n'));
    check(body.includes('Tên cuộc họp: Họp dự án tủ điện') && body.includes('Vietnamese: Chúng ta cần hoàn thành thiết kế điện trước thứ Sáu.'), 'File TXT UTF-8 đúng định dạng, có dấu tiếng Việt');

    console.log('9. Lịch sử cuộc họp');
    await page.goto(`${base}/history`);
    await page.getByRole('heading', { name: 'Họp dự án tủ điện' }).waitFor();
    check(true, 'Cuộc họp đã lưu xuất hiện trong Lịch sử');
    await page.screenshot({ path: path.join(shotsDir, '06-history.png') });

    console.log('10. Chế độ Demo + Biên bản AI');
    await page.goto(base);
    await page.getByRole('button', { name: 'Thử chế độ Demo' }).click();
    await page.getByText('CHẾ ĐỘ DEMO').first().waitFor();
    check(true, 'Cuộc họp demo được gắn nhãn rõ ràng');
    await page.getByRole('button', { name: 'Chạy demo' }).first().click();
    await page.getByText('Chúng ta cần hoàn thành thiết kế điện trước thứ Sáu.').first().waitFor({ timeout: 15_000 });
    check(true, 'Demo phát transcript mẫu không cần API Key');
    await page.screenshot({ path: path.join(shotsDir, '07-demo.png') });
    await page.getByRole('tab', { name: 'Biên bản AI' }).click();
    await page.getByRole('button', { name: 'Tạo báo cáo bằng AI' }).click();
    await page.getByText('Công việc cần thực hiện').first().waitFor();
    check(await page.getByText('Chưa nêu rõ').first().isVisible(), 'Báo cáo hiển thị "Chưa nêu rõ" khi không có người phụ trách/thời hạn');
    await page.screenshot({ path: path.join(shotsDir, '08-summary.png') });

    const relevant = errors.filter((e) => !/favicon|ERR_ABORTED/.test(e));
    check(relevant.length === 0, `Không có lỗi JavaScript trên trang${relevant.length ? ': ' + relevant.join(' | ') : ''}`);
    console.log('\nTẤT CẢ BƯỚC KIỂM THỬ TRÌNH DUYỆT ĐỀU ĐẠT. Ảnh chụp: e2e/screenshots/');
  } catch (err) {
    for (const ctx of browser.contexts()) for (const pg of ctx.pages()) {
      const texts = await pg.locator('article').allInnerTexts().catch(() => [] as string[]);
      console.log('--- Nội dung transcript khi lỗi:\n' + texts.join('\n---\n'));
      await pg.screenshot({ path: path.join(shotsDir, 'failure.png') }).catch(() => {});
    }
    throw err;
  } finally {
    await browser.close();
    await app.close();
    await mock.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
