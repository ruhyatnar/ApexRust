import React, { useState } from 'react';
import { Download, Monitor, WifiOff, X } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { usePWAInstall } from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        aria-label="Install ApexRust Desktop App"
        className="hidden sm:flex items-center gap-1.5 rounded-lg border border-[#7DF2AD]/35 bg-[#7DF2AD]/10 px-2.5 py-1.5 text-xs font-semibold text-[#7DF2AD] transition hover:bg-[#7DF2AD]/20 whitespace-nowrap"
      >
        <Download className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Install Desktop App</span>
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setShowGuide(true)}
        aria-label="Desktop App install options"
        className="hidden sm:flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#141820] px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:border-[#7DF2AD]/40 hover:text-[#7DF2AD] whitespace-nowrap"
      >
        <Monitor className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Desktop App</span>
      </button>

      {showGuide && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Desktop Application Setup"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        >
          <div className="w-full max-w-md rounded-xl border border-white/[0.08] bg-[#141820] p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-white/[0.06] pb-3">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#7DF2AD]/30 bg-[#7DF2AD]/10">
                  <Monitor className="h-4 w-4 text-[#7DF2AD]" aria-hidden="true" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">
                    Launch ApexRust as a Desktop App
                  </h3>
                  <p className="text-xs text-slate-400">
                    Standalone Window Mode & Native Linux Binary
                  </p>
                </div>
              </div>
              <button
                type="button"
                aria-label="Close desktop app guide"
                onClick={() => setShowGuide(false)}
                className="rounded-md p-1 text-slate-400 hover:bg-white/[0.06] hover:text-slate-100"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="mt-4 space-y-3 text-xs leading-relaxed text-slate-300">
              {isIOS ? (
                <div className="rounded-lg border border-white/[0.06] bg-[#0D1015] p-3">
                  <p className="font-semibold text-slate-100">iOS / iPadOS Installation</p>
                  <p className="mt-1 text-slate-400">
                    Tap the <strong>Share</strong> icon in Safari and select{' '}
                    <strong>Add to Home Screen</strong>.
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-white/[0.06] bg-[#0D1015] p-3">
                  <p className="font-semibold text-slate-100">
                    1. Install Standalone Desktop App (Chrome / Edge / Brave)
                  </p>
                  <p className="mt-1 text-slate-400">
                    Click the <strong>Install ApexRust</strong> icon in your browser address bar
                    (or Browser Menu → <em>Cast, save, and share → Install page as app</em>) to run
                    in a dedicated standalone desktop window with offline asset caching and native
                    push notifications.
                  </p>
                </div>
              )}

              <div className="rounded-lg border border-white/[0.06] bg-[#0D1015] p-3">
                <p className="font-semibold text-slate-100">
                  2. Native Rust Linux Desktop Engine (<code className="font-mono text-[#7DF2AD]">bot-desktop</code>)
                </p>
                <pre className="mt-2 whitespace-pre-wrap break-words rounded border border-white/[0.06] bg-[#090C11] p-2 font-mono text-[11px] text-[#7DF2AD]">
                  cd rust-bot && cargo run --release -p bot-desktop -- --web-port 8080
                </pre>
              </div>
            </div>

            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="rounded-lg bg-[#7DF2AD] px-4 py-1.5 text-xs font-bold text-[#0B0F17] transition hover:bg-[#95F7BD]"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg border border-amber-400/40 bg-amber-950/90 px-3 py-1.5 text-xs font-medium text-amber-200 shadow-lg backdrop-blur"
    >
      <WifiOff className="h-3.5 w-3.5 text-amber-300" aria-hidden="true" />
      <span>Offline Mode — Local desktop cache & Paper Sandbox active</span>
    </div>
  );
};
