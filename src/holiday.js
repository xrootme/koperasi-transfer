async function isTanggalMerah(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);

  if (d.getDay() === 0) return { holiday: true, reason: "Minggu" };

  const iso = d.toISOString().slice(0, 10);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;

  const controllers = [];
  const fetchWithTimeout = (url, ms = 5000) => {
    const c = new AbortController();
    controllers.push(c);
    const t = setTimeout(() => c.abort(), ms);
    return fetch(url, { signal: c.signal }).finally(() => clearTimeout(t));
  };

  const urls = [
    `https://api-harilibur.vercel.app/api?month=${m}&year=${y}`,
    `https://libur.deno.dev/api?month=${m}&year=${y}`,
  ];

  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) continue;
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.data || [];
      const found = list.find((x) => {
        const tgl = x.holiday_date || x.date || x.tanggal || "";
        const isNational = x.is_national_holiday ?? x.national ?? x.isNational ?? true;
        return tgl === iso && isNational;
      });
      if (found) return { holiday: true, reason: found.holiday_name || found.name || found.holidayName || "Hari libur nasional" };
      if (list.length > 0) return { holiday: false, reason: "" };
    } catch (_) {}
  }

  return { holiday: false, reason: "" };
}

module.exports = { isTanggalMerah };
