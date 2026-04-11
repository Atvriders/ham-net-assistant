import React, { useRef, useState } from 'react';
import ReactCrop, { type Crop, centerCrop, makeAspectCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import { Modal } from './ui/Modal.js';
import { Button } from './ui/Button.js';
import { Input } from './ui/Input.js';

type Tab = 'file' | 'url';

function centeredSquare(width: number, height: number): Crop {
  return centerCrop(
    makeAspectCrop({ unit: '%', width: 80 }, 1, width, height),
    width,
    height,
  );
}

async function cropToBlob(
  image: HTMLImageElement,
  crop: Crop,
): Promise<Blob> {
  const scaleX = image.naturalWidth / image.width;
  const scaleY = image.naturalHeight / image.height;
  const pxCrop = {
    x: (crop.x || 0) * (crop.unit === '%' ? image.width / 100 : 1),
    y: (crop.y || 0) * (crop.unit === '%' ? image.height / 100 : 1),
    width: (crop.width || 0) * (crop.unit === '%' ? image.width / 100 : 1),
    height: (crop.height || 0) * (crop.unit === '%' ? image.height / 100 : 1),
  };
  const canvas = document.createElement('canvas');
  const size = Math.max(1, Math.round(pxCrop.width * scaleX));
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2d context');
  ctx.drawImage(
    image,
    pxCrop.x * scaleX,
    pxCrop.y * scaleY,
    pxCrop.width * scaleX,
    pxCrop.height * scaleY,
    0,
    0,
    size,
    size,
  );
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png');
  });
}

async function uploadMultipart(slug: string, blob: Blob, filename: string) {
  const form = new FormData();
  form.append('logo', blob, filename);
  const res = await fetch(`/api/themes/${slug}/logo`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
}

async function uploadUrl(slug: string, url: string, signal?: AbortSignal) {
  const res = await fetch(`/api/themes/${slug}/logo`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body?.error?.message ?? `Upload failed: ${res.status}`);
  }
}

export function LogoUploadModal({
  open,
  slug,
  onClose,
  onUploaded,
}: {
  open: boolean;
  slug: string;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const [tab, setTab] = useState<Tab>('file');
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [crop, setCrop] = useState<Crop>();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  function reset() {
    setImageSrc(null);
    setUrl('');
    setCrop(undefined);
    setErr(null);
    setBusy(false);
    abortRef.current?.abort();
    abortRef.current = null;
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setImageSrc(reader.result as string);
    reader.readAsDataURL(f);
  }

  function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const { width, height } = e.currentTarget;
    setCrop(centeredSquare(width, height));
  }

  async function saveCropped() {
    if (!imgRef.current || !crop) return;
    setBusy(true);
    setErr(null);
    try {
      const blob = await cropToBlob(imgRef.current, crop);
      await uploadMultipart(slug, blob, `${slug}.png`);
      onUploaded();
      reset();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveUrlOriginal() {
    if (!/^https?:\/\//i.test(url)) {
      setErr('Enter a http(s) url');
      return;
    }
    setBusy(true);
    setErr(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await uploadUrl(slug, url, ctrl.signal);
      onUploaded();
      reset();
      onClose();
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={() => { reset(); onClose(); }}>
      <div style={{ minWidth: 420 }}>
        <h2 style={{ marginTop: 0 }}>Upload logo for {slug}</h2>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <Button
            variant={tab === 'file' ? 'primary' : 'secondary'}
            onClick={() => { setTab('file'); setImageSrc(null); }}
          >
            Upload file
          </Button>
          <Button
            variant={tab === 'url' ? 'primary' : 'secondary'}
            onClick={() => { setTab('url'); setImageSrc(null); }}
          >
            From URL
          </Button>
        </div>

        {tab === 'file' && (
          <div>
            <input type="file" accept="image/*" onChange={onFile} />
            {imageSrc && (
              <div style={{ marginTop: 12 }}>
                <ReactCrop
                  crop={crop}
                  onChange={(c) => setCrop(c)}
                  aspect={1}
                  keepSelection
                >
                  <img
                    ref={imgRef}
                    src={imageSrc}
                    alt="to crop"
                    style={{ maxWidth: '100%', maxHeight: 320 }}
                    onLoad={onImageLoad}
                  />
                </ReactCrop>
              </div>
            )}
          </div>
        )}

        {tab === 'url' && (
          <div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Input
                placeholder="https://example.com/logo.png"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <Button onClick={saveUrlOriginal} disabled={busy || !url}>
                Upload
              </Button>
            </div>
            <div style={{ fontSize: 12, marginTop: 6, color: 'var(--color-muted)' }}>
              The server fetches and stores the image as-is. To crop, use the file tab.
            </div>
          </div>
        )}

        {err && (
          <div role="alert" style={{ color: 'var(--color-danger)', marginTop: 12 }}>
            {err}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          {tab === 'file' && imageSrc && (
            <Button onClick={saveCropped} disabled={busy}>
              Save cropped
            </Button>
          )}
          <Button variant="secondary" onClick={() => { reset(); onClose(); }}>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}
