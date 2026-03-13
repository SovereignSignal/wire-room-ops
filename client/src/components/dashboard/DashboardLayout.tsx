import { ReactNode, useState, useEffect } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ThemeToggle } from './ThemeToggle';
import { LogOut, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

interface DashboardLayoutProps {
  children: ReactNode;
  activeTab: string;
  onTabChange: (tab: string) => void;
  queueCount: number;
  lastUpdated: Date | null;
  refreshing: boolean;
  onRefresh: () => void;
}

async function handleLogout() {
  await fetch('/logout', { method: 'GET', credentials: 'include' });
  window.location.href = '/';
}

export function DashboardLayout({
  children,
  activeTab,
  onTabChange,
  queueCount,
  lastUpdated,
  refreshing,
  onRefresh,
}: DashboardLayoutProps) {
  // Re-render the "ago" label every 15s so it stays current
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-border bg-card/80 backdrop-blur-sm relative">
        <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent" />
        <div className="container py-3 sm:py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 sm:gap-4">
              <div className="relative">
                <div className="w-8 h-8 sm:w-10 sm:h-10 rounded bg-gradient-to-br from-primary/20 to-accent/20 border border-primary/30 flex items-center justify-center glow-box">
                  <span className="text-lg sm:text-xl">🛰️</span>
                </div>
                <div className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-primary signal-pulse" />
              </div>
              <div>
                <h1 className="text-lg sm:text-xl font-display font-semibold tracking-wider glow-text">WIREOPS</h1>
                <p className="text-[9px] sm:text-[10px] text-muted-foreground tracking-widest uppercase hidden sm:block">Array Control Station</p>
              </div>
            </div>
            <div className="flex items-center gap-3 sm:gap-6">
              <div className="hidden sm:flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-status-success signal-pulse" />
                <span className="text-xs text-muted-foreground font-mono">ARRAY ONLINE</span>
              </div>
              <button
                onClick={onRefresh}
                disabled={refreshing}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[10px] sm:text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-primary/10 border border-transparent hover:border-primary/30 transition-all disabled:opacity-50"
                title={lastUpdated ? `Last synced: ${lastUpdated.toLocaleTimeString()}` : 'Refresh data'}
              >
                <RefreshCw className={`w-3 h-3 sm:w-3.5 sm:h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                {lastUpdated ? (
                  <span className="hidden sm:inline">{formatTimeAgo(lastUpdated)}</span>
                ) : (
                  <span className="hidden sm:inline">SYNC</span>
                )}
              </button>
              <ThemeToggle />
              <Button
                variant="ghost"
                size="sm"
                onClick={handleLogout}
                className="gap-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 font-display text-[10px] tracking-wider border border-transparent hover:border-destructive/30 transition-colors"
                title="Log out"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">LOGOUT</span>
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Navigation — horizontally scrollable on mobile */}
      <div className="border-b border-border bg-card/50 backdrop-blur-sm">
        <div className="container overflow-x-auto scrollbar-hide">
          <Tabs value={activeTab} onValueChange={onTabChange}>
            <TabsList className="h-12 bg-transparent border-none gap-1 sm:gap-2 flex-nowrap w-max sm:w-auto">
              <TabsTrigger 
                value="overview" 
                className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:border-primary/30 border border-transparent gap-1.5 px-2.5 sm:px-4 font-display text-[10px] sm:text-xs tracking-wider whitespace-nowrap"
              >
                <span className="text-sm">👁️</span>
                OVERVIEW
              </TabsTrigger>
              <TabsTrigger 
                value="queue" 
                className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:border-primary/30 border border-transparent gap-1.5 px-2.5 sm:px-4 font-display text-[10px] sm:text-xs tracking-wider whitespace-nowrap"
              >
                <span className="text-sm">📡</span>
                QUEUE
                {queueCount > 0 && (
                  <span className="ml-1 px-2 py-0.5 text-[10px] rounded bg-primary/20 text-primary font-mono border border-primary/30">
                    {queueCount}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger 
                value="published" 
                className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:border-primary/30 border border-transparent gap-1.5 px-2.5 sm:px-4 font-display text-[10px] sm:text-xs tracking-wider whitespace-nowrap"
              >
                <span className="text-sm">✅</span>
                PUBLISHED
              </TabsTrigger>
              <TabsTrigger
                value="database"
                className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:border-primary/30 border border-transparent gap-1.5 px-2.5 sm:px-4 font-display text-[10px] sm:text-xs tracking-wider whitespace-nowrap"
              >
                <span className="text-sm">🗄️</span>
                DATABASE
              </TabsTrigger>
              <TabsTrigger
                value="settings"
                className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:border-primary/30 border border-transparent gap-1.5 px-2.5 sm:px-4 font-display text-[10px] sm:text-xs tracking-wider whitespace-nowrap"
              >
                <span className="text-sm">⚙️</span>
                SETTINGS
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      {/* Content */}
      <main className="container py-6">
        {children}
      </main>
    </div>
  );
}
