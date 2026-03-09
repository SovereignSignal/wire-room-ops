import { ReactNode } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ThemeToggle } from './ThemeToggle';

interface DashboardLayoutProps {
  children: ReactNode;
  activeTab: string;
  onTabChange: (tab: string) => void;
  queueCount: number;
  reviewCount: number;
}

export function DashboardLayout({ 
  children, 
  activeTab, 
  onTabChange,
  queueCount,
  reviewCount 
}: DashboardLayoutProps) {
  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-border bg-card/80 backdrop-blur-sm relative">
        <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent" />
        <div className="container py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="relative">
                <div className="w-10 h-10 rounded bg-gradient-to-br from-primary/20 to-accent/20 border border-primary/30 flex items-center justify-center glow-box">
                  <span className="text-xl">🛰️</span>
                </div>
                <div className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-primary signal-pulse" />
              </div>
              <div>
                <h1 className="text-xl font-display font-semibold tracking-wider glow-text">WIREOPS</h1>
                <p className="text-[10px] text-muted-foreground tracking-widest uppercase">Array Control Station</p>
              </div>
            </div>
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-status-success signal-pulse" />
                <span className="text-xs text-muted-foreground font-mono">ARRAY ONLINE</span>
              </div>
              <div className="text-xs text-muted-foreground font-mono border border-border px-3 py-1.5 rounded bg-card/50">
                SYS v1.0.4 • LAT 42.3°N
              </div>
              <ThemeToggle />
            </div>
          </div>
        </div>
      </header>

      {/* Navigation */}
      <div className="border-b border-border bg-card/50 backdrop-blur-sm">
        <div className="container">
          <Tabs value={activeTab} onValueChange={onTabChange}>
            <TabsList className="h-12 bg-transparent border-none gap-2 flex-wrap sm:flex-nowrap">
              <TabsTrigger 
                value="overview" 
                className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:border-primary/30 border border-transparent gap-2 px-4 font-display text-xs tracking-wider"
              >
                <span className="text-sm">👁️</span>
                OVERVIEW
              </TabsTrigger>
              <TabsTrigger 
                value="queue" 
                className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:border-primary/30 border border-transparent gap-2 px-4 font-display text-xs tracking-wider"
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
                className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:border-primary/30 border border-transparent gap-2 px-4 font-display text-xs tracking-wider"
              >
                <span className="text-sm">✅</span>
                PUBLISHED
              </TabsTrigger>
              <TabsTrigger 
                value="review" 
                className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:border-primary/30 border border-transparent gap-2 px-4 font-display text-xs tracking-wider"
              >
                <span className="text-sm">⚠️</span>
                REVIEW
                {reviewCount > 0 && (
                  <span className="ml-1 px-2 py-0.5 text-[10px] rounded bg-status-warning/20 text-status-warning font-mono border border-status-warning/30">
                    {reviewCount}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger 
                value="sources" 
                className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:border-primary/30 border border-transparent gap-2 px-4 font-display text-xs tracking-wider"
              >
                <span className="text-sm">🛰️</span>
                SOURCES
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
