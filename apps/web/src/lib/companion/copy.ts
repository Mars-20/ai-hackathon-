// Arabic UI copy — spec §9 table, VERBATIM (Task 3 interface). No other
// module may inline Arabic strings; import from here.

export const MEMORY_COPY = {
  page_title: "ذكرياتي",
  pending_queue: "بانتظار موافقتك",
  approve: "اعتماد",
  edit_approve: "تعديل واعتماد",
  reject: "رفض",
  forget: "نسيان نهائي",
  forget_confirm: "سيُحذف نهائيًا من كل مكان — متأكد؟",
  disable: "إيقاف الذاكرة مؤقتًا",
  disable_hint: "يتوقف التخصيص دون حذف أي شيء",
  conflict_pair: "يتعارض مع ذكرى معتمدة — اختر الصحيحة",
  empty_queue: "لا شيء بانتظارك — سأقترح ما أتعلمه هنا",
  provenance: "من جلسة {date} (عرض التاريخ بlocale عربي)",
  cap_full: "القائمة ممتلئة — احذف ذكرى أولًا",
  memory_full: "ذاكرتك ممتلئة (200) — احذف أو اندمج قبل إضافة جديد",
  memory_duplicate: "مكررة — هذه الذكرى معتمدة مسبقًا",
  startup_not_owned: "هذا المشروع ليس لك",
  secret_blocked: "عذرًا — لا أحفظ المفاتيح والبيانات الحساسة",
} as const;

export type MemoryCopyKey = keyof typeof MEMORY_COPY;
