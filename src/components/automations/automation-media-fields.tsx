"use client";

import { useCallback, useRef, useState } from "react";
import { FileText, ImageIcon, Loader2, Paperclip, Upload, Video, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { uploadAccountMedia, MEDIA_MAX_BYTES_BY_KIND } from "@/lib/storage/upload-media";

export type AutomationMediaType = "image" | "video" | "document";

export interface AutomationMediaConfig {
  media_type?: AutomationMediaType;
  media_url?: string;
  caption?: string;
  filename?: string;
}

interface Props {
  config: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}

const MEDIA_ACCEPT: Record<AutomationMediaType, string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
};

const MEDIA_BUCKET = "flow-media";

export function AutomationMediaFields({ config, onChange }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const cfg = config as AutomationMediaConfig;
  const mediaType = cfg.media_type ?? "image";
  const maxBytes = MEDIA_MAX_BYTES_BY_KIND[mediaType];
  const displayName =
    cfg.filename ||
    (cfg.media_url ? cfg.media_url.split("/").pop() ?? "" : "");

  const handleFile = useCallback(
    async (file: File) => {
      if (file.size > maxBytes) {
        toast.error(
          `File is ${(file.size / 1024 / 1024).toFixed(1)} MB — limit for ${mediaType} is ${Math.round(maxBytes / 1024 / 1024)} MB.`,
        );
        return;
      }

      setUploading(true);
      try {
        const { publicUrl } = await uploadAccountMedia(MEDIA_BUCKET, file);
        onChange({
          media_url: publicUrl,
          filename: file.name,
        });
        toast.success("File uploaded.");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Upload failed.");
      } finally {
        setUploading(false);
      }
    },
    [maxBytes, mediaType, onChange],
  );

  const Icon =
    mediaType === "image" ? ImageIcon : mediaType === "video" ? Video : FileText;

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          Media type
        </label>
        <select
          value={mediaType}
          onChange={(event) =>
            onChange({
              media_type: event.target.value as AutomationMediaType,
              media_url: "",
              filename: "",
            })
          }
          className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
        >
          <option value="image">Image</option>
          <option value="video">Video</option>
          <option value="document">Document / PDF</option>
        </select>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          File
        </label>

        {cfg.media_url ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs">
            <Icon className="h-3.5 w-3.5 shrink-0 text-primary" />
            <a
              href={cfg.media_url}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1 truncate text-foreground hover:text-primary"
              title={displayName || cfg.media_url}
            >
              {displayName || cfg.media_url}
            </a>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => onChange({ media_url: "", filename: "" })}
              disabled={uploading}
              className="h-7 w-7"
              aria-label="Remove file"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-card px-3 py-4 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            {uploading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Uploading…
              </>
            ) : (
              <>
                <Upload className="h-3.5 w-3.5" />
                Upload image, video, or document
              </>
            )}
          </button>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept={MEDIA_ACCEPT[mediaType]}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleFile(file);
            event.target.value = "";
          }}
        />

        <p className="mt-1 text-[11px] text-muted-foreground">
          Files are stored in the account-scoped WACRM media storage. Image limit 5 MB; video/document 16 MB.
        </p>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          Caption
        </label>
        <Textarea
          value={cfg.caption ?? ""}
          onChange={(event) => onChange({ caption: event.target.value })}
          maxLength={1024}
          placeholder="Optional text shown with the media"
          className="min-h-20 bg-muted text-foreground"
        />
      </div>

      {mediaType === "document" && (
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Filename shown to customer
          </label>
          <div className="relative">
            <Paperclip className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={cfg.filename ?? ""}
              onChange={(event) => onChange({ filename: event.target.value })}
              placeholder="brochure.pdf"
              className="bg-muted pl-8 text-foreground"
            />
          </div>
        </div>
      )}
    </div>
  );
}
