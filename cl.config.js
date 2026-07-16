/* =====================================================================
 * cl.config.js — Cấu hình kết nối Supabase (nạp TRƯỚC cl.sync.js)
 * ---------------------------------------------------------------------
 * 1) Tạo project tại https://supabase.com (Free) — xem HUONG-DAN-SUPABASE.md
 * 2) Vào Project Settings → API, copy:
 *      - Project URL        → dán vào SUPABASE_URL
 *      - anon public key     → dán vào SUPABASE_ANON_KEY  (khóa CÔNG KHAI, an toàn nhúng)
 * 3) Bảo mật thật do RLS (Row Level Security) trong DB đảm nhiệm, không phải khóa này.
 *
 * Chưa điền gì cũng KHÔNG sao: app tự chạy OFFLINE hoàn toàn (LocalStorage) như cũ.
 * ===================================================================== */
window.CL_CONFIG = {
  SUPABASE_URL:      "https://gfawruxtpulawwuzvzea.supabase.co",   // Project URL — KHÔNG kèm /rest/v1/
  SUPABASE_ANON_KEY: "sb_publishable_7ynpWgZQM33U2aPPkUtD8g_LF6GyA0j",   // publishable/anon key (công khai)

  // Bật/tắt đồng bộ đám mây. false hoặc thiếu URL/KEY => chạy offline thuần.
  SYNC_ENABLED: true,

  // Tự nạp bản mới nhất của xưởng khi đăng nhập (đọc từ cache trước, rồi làm tươi từ DB).
  AUTO_LOAD_LATEST: true,

  // Số ngày giữ đơn trên DB (đơn cũ hơn -> gợi ý xuất file Project rồi xóa khỏi DB).
  RETENTION_DAYS: 180
};
