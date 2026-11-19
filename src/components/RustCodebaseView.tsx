import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, FileCode2, FolderTree, Search, Terminal } from 'lucide-react';

// Dynamically bundle all source/config/doc files from /rust-bot/ (excluding Cargo target and secret config artifacts)
const rawRustModules = import.meta.glob(
  [
    '/rust-bot/**/*',
    '!/rust-bot/target/**',
    '!/rust-bot/Cargo.lock',
    '!/rust-bot/config/bot.toml',
    '!/rust-bot/config/bot.toml.bak',
  ],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  }
) as Record<string, string>;

interface RustFileEntry {
  path: string;
  group: string;
  content: string;
}

function classifyGroup(relPath: string): string {
  if (relPath.startsWith('docs/')) return 'Documentation & AI Handoff';
  if (relPath.startsWith('config/') || relPath.startsWith('deploy/')) return 'Config & Linux Deploy';
  if (relPath.startsWith('crates/')) {
    const parts = relPath.split('/');
    return `Crate: ${parts[1]}`;
  }
  return 'Workspace Root';
}

export const RustCodebaseView: React.FC = () => {
  const files = useMemo<RustFileEntry[]>(() => {
    return Object.entries(rawRustModules)
      .map(([fullPath, content]) => {
        const rel = fullPath.replace(/^\/rust-bot\//, '');
        return {
          path: rel,
          group: classifyGroup(rel),
          content: typeof content === 'string' ? content : '',
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  }, []);

  const [search, setSearch] = useState('');
  const [selectedPath, setSelectedPath] = useState<string>(() => {
    return (
      files.find((f) => f.path === 'crates/bot-exchange/src/binance_ws.rs')?.path ??
      files[0]?.path ??
      ''
    );
  });
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const filteredFiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return files;
    return files.filter(
      (f) => f.path.toLowerCase().includes(q) || f.content.toLowerCase().includes(q)
    );
  }, [files, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, RustFileEntry[]>();
    for (const f of filteredFiles) {
      const list = map.get(f.group) ?? [];
      list.push(f);
      map.set(f.group, list);
    }
    return Array.from(map.entries());
  }, [filteredFiles]);

  const activeFile =
    files.find((f) => f.path === selectedPath) ?? filteredFiles[0] ?? files[0];

  const handleCopy = async () => {
    if (!activeFile) return;
    try {
      await navigator.clipboard.writeText(activeFile.content);
      setCopied(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard fallback ignored if blocked in headless frame
    }
  };

  return (
    <div className="space-y-5">
      {/* Linux Desktop & WebApp Launch Strip */}
      <div className="rounded-lg border border-white/[0.06] bg-[#141820] p-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Terminal className="h-5 w-5 text-[#7DF2AD]" aria-hidden="true" />
            <div>
              <h2 className="text-sm font-semibold text-slate-100">
                Rust Cargo Workspace (Linux Desktop + WebApp Ready)
              </h2>
              <p className="text-xs text-slate-400">
                Built on official <code className="font-mono text-slate-200">binance-sdk</code> (
                <code className="font-mono text-slate-200">SpotRestApi</code>,{' '}
                <code className="font-mono text-slate-200">SpotWsApi</code>,{' '}
                <code className="font-mono text-slate-200">SpotWsStreams</code>) with 8 modular crates.
              </p>
            </div>
          </div>

          <div className="max-w-full overflow-x-auto rounded-md border border-slate-800 bg-slate-950 px-3 py-1.5 font-mono text-xs text-slate-200 whitespace-nowrap">
            cd rust-bot &amp;&amp; cargo run --release -p bot-desktop -- --web-port 8080
          </div>
        </div>
      </div>

      {/* 2-Column Tree & Source Inspector */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Left File Tree */}
        <div className="min-w-0 rounded-lg border border-white/[0.06] bg-[#141820] lg:col-span-4">
          <div className="border-b border-slate-800 p-3">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-500"
                aria-hidden="true"
              />
              <label htmlFor="rust-file-search" className="sr-only">
                Search Rust workspace files
              </label>
              <input
                id="rust-file-search"
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search crates, docs, symbols..."
                className="w-full rounded-md border border-slate-700 bg-slate-900 py-1.5 pl-8 pr-3 text-xs text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="max-h-[540px] divide-y divide-slate-800/70 overflow-y-auto">
            {grouped.length === 0 ? (
              <div className="p-4 text-center text-xs text-slate-400">
                No matching files found in workspace.
              </div>
            ) : (
              grouped.map(([group, entries]) => (
                <div key={group} className="p-2.5">
                  <div className="mb-1.5 flex items-center gap-1.5 px-2 text-[11px] font-semibold text-slate-400">
                    <FolderTree className="h-3 w-3" aria-hidden="true" />
                    <span>{group}</span>
                  </div>
                  <div className="space-y-0.5">
                    {entries.map((file) => {
                      const active = activeFile?.path === file.path;
                      return (
                        <button
                          key={file.path}
                          type="button"
                          onClick={() => setSelectedPath(file.path)}
                          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-xs transition ${
                            active
                              ? 'bg-[#7DF2AD]/15 text-[#7DF2AD]'
                              : 'text-slate-300 hover:bg-white/[0.04]'
                          }`}
                        >
                          <FileCode2 className="h-3.5 w-3.5 shrink-0 opacity-75" aria-hidden="true" />
                          <span className="truncate">{file.path}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right Source / Docs Viewer */}
        <div className="min-w-0 rounded-lg border border-white/[0.06] bg-[#141820] lg:col-span-8">
          {activeFile && (
            <>
              <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs font-semibold text-slate-100">
                    rust-bot/{activeFile.path}
                  </div>
                  <div className="text-[11px] text-slate-400">
                    {activeFile.content.split('\n').length} lines · {activeFile.group}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleCopy}
                  className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-800 whitespace-nowrap shrink-0"
                >
                  {copied ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Copy Source</span>
                    </>
                  )}
                </button>
              </div>

              <div className="max-h-[540px] overflow-auto bg-[#0D1015] p-4">
                <pre className="font-mono text-xs leading-relaxed text-slate-200">
                  <code>{activeFile.content}</code>
                </pre>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
