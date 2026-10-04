# Setup Hermes AI Vision di VPS

Bot `koperasi-transfer` memakai **Hermes** (atau model lokal lain yang kompatibel OpenAI) untuk
verifikasi bukti transfer. Semua inference dilakukan **di dalam VPS** — tidak ada data yang
dikirim ke layanan cloud.

---

## 1. Pilih Server Inference

Bot memanggil endpoint OpenAI-compatible di `/v1/chat/completions` dengan `image_url` (base64),
sehingga **model harus mendukung vision (multimodal)**.

### Opsi A — llama.cpp server (paling ringan, ~2-4 GB RAM)

Cocok untuk VPS kecil (1 vCPU / 2 GB). Model quantized GGUF.

```bash
cd /home/ubuntu
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
cmake -B build -DGGML_CUDA=OFF
cmake --build build --config Release -j$(nproc)

# Download model vision (Q4_K_M ~2.5 GB)
wget https://huggingface.co/Qwen/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/qwen2.5-vl-3b-instruct-q4_k_m.gguf \
  -O /home/ubuntu/qwen2.5-vl.gguf

# Jalankan server di port 8080
./build/bin/llama-server \
  -m /home/ubuntu/qwen2.5-vl.gguf \
  --host 127.0.0.1 \
  --port 8080 \
  --ctx-size 4096 \
  --jinja
```

### Opsi B — Hermes via vLLM (multimodal, butuh GPU ≥8 GB)

```bash
pip install vllm
python -m vllm.entrypoints.openai.api_server \
  --model NousResearch/Hermes-3-Vision \
  --host 127.0.0.1 \
  --port 8080 \
  --max-model-len 8192
```

### Opsi C — Ollama (paling mudah setup)

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen2.5vl:7b
# Ollama expose OpenAI-compatible API di port 11434
```

---

## 2. Konfigurasi `.env`

```ini
AI_PROVIDER=local
LOCAL_AI_URL=http://127.0.0.1:8080/v1
LOCAL_AI_MODEL=hermes
LOCAL_AI_API_KEY=
LOCAL_AI_TIMEOUT_MS=120000
LOCAL_AI_RESPONSE_FORMAT=json_object
```

| Variabel | Keterangan |
|---|---|
| `AI_PROVIDER` | `local` (default) atau `gemini` |
| `LOCAL_AI_URL` | Base URL OpenAI-compatible, contoh `http://127.0.0.1:8080/v1` |
| `LOCAL_AI_MODEL` | Nama model sesuai server |
| `LOCAL_AI_API_KEY` | Kosongkan kalau tanpa autentikasi |
| `LOCAL_AI_TIMEOUT_MS` | Timeout default `120000` ms (2 menit) |
| `LOCAL_AI_RESPONSE_FORMAT` | `json_object` (default) atau `none` |

---

## 3. Uji Koneksi

```bash
curl http://127.0.0.1:8080/v1/models
```

Jika berhasil, akan mengembalikan JSON berisi daftar model yang tersedia.
Gunakan nama model dari output ini untuk `LOCAL_AI_MODEL`.

---

## 4. Jalankan sebagai Service (systemd)

```ini
# /etc/systemd/system/llama-server.service
[Unit]
Description=Llama.cpp Vision Server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/llama.cpp
ExecStart=/home/ubuntu/llama.cpp/build/bin/llama-server \
  -m /home/ubuntu/qwen2.5-vl.gguf \
  --host 127.0.0.1 \
  --port 8080 \
  --ctx-size 4096 \
  --jinja
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now llama-server
sudo systemctl status llama-server
```

---

## 5. Jalankan Bot

```bash
cd /home/ubuntu/koperasi-transfer
pm2 restart koperasi-reminder
pm2 logs koperasi-reminder
```

Log startup akan menampilkan:
```
AI Vision: LOKAL → http://127.0.0.1:8080/v1 (model: hermes)
```

---

## 6. Troubleshooting

| Error | Penyebab & Solusi |
|---|---|
| `ECONNREFUSED` | Server AI belum jalan → `sudo systemctl start llama-server` |
| `model not found` | Nama model salah → cek `curl /v1/models` |
| `image_url not supported` | Model text-only (bukan vision) → ganti model vision |
| `response_format not supported` | Set `LOCAL_AI_RESPONSE_FORMAT=none` |
| `timeout` | Model terlalu besar → pakai quantized Q4, turunkan `--ctx-size` |
| `OOM` | RAM tidak cukup → downgrade ke model 3B |

### Cek Memory
```bash
free -h
pm2 monit
```

---

## 7. Model untuk VPS Budget

| Model | Ukuran | RAM Min | Kualitas OCR |
|---|---|---|---|
| Qwen2.5-VL-3B-Q4 | ~2.5 GB | 4 GB | ★★★☆ |
| Qwen2.5-VL-7B-Q4 | ~4.5 GB | 8 GB | ★★★★ |
| Hermes-3-Vision | ~8 GB | 12 GB | ★★★★ |

Untuk struk transfer Indonesia (BCA/BRI/m-banking/e-wallet), Qwen2.5-VL-7B sudah cukup.

---

## 8. Keamanan

- Server AI hanya listen di `127.0.0.1` (loopback) — tidak bisa diakses dari luar VPS.
- Tidak ada data keluar dari VPS — semua inferensi lokal.
- Untuk testing dari lokal: `ssh -L 8080:127.0.0.1:8080 ubuntu@ip-vps` lalu buka `http://127.0.0.1:8080`.
