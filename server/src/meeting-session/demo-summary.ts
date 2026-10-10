import type { MeetingSummary } from '@amt/shared';

/** Báo cáo MẪU cho cuộc họp demo – gắn nhãn provider "demo", không phải kết quả AI. */
export const DEMO_SUMMARY: MeetingSummary = {
  overview: '[DEMO] Cuộc họp rà soát tiến độ dự án tủ điều khiển: thiết kế điện, máng cáp, bản vẽ E-201, cấu hình PLC và màn hình HMI.',
  topics: ['Tiến độ thiết kế điện', 'Kích thước máng cáp', 'Bản vẽ E-201 rev C', 'Cấu hình PLC và BOM', 'Màn hình HMI cho tích hợp SCADA'],
  discussions: [
    'Cần hoàn thành thiết kế điện trước thứ Sáu.',
    'Cần kiểm tra lại kích thước máng cáp.',
    'PLC Siemens S7-1500 với 128 đầu vào số, BOM cần cập nhật tương ứng.',
  ],
  decisions: [],
  actionItems: [
    { task: 'Gửi bản vẽ E-201 phiên bản C', owner: 'Speaker B', deadline: 'Trưa mai', evidence: 'I will send drawing E-201 revision C by tomorrow noon.' },
    { task: 'Cập nhật BOM theo cấu hình PLC', owner: null, deadline: null, evidence: 'Please update the BOM accordingly.' },
  ],
  openIssues: ['Màn hình HMI cho tích hợp SCADA chưa được quyết định – hẹn thảo luận tuần sau.'],
  generatedAt: '',
  provider: 'demo',
  model: 'dữ liệu mẫu',
  editedMarkdown: null,
};
