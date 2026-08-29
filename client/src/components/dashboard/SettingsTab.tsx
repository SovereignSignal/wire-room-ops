import { useState } from 'react';
import { SourcesTab } from './SourcesTab';
import { DistributionTab } from './DistributionTab';
import { IntegrationsTab } from './IntegrationsTab';
import { DailyDigestCard } from './DailyDigestCard';
import { ProvidersTab } from './ProvidersTab';
import { UsageTab } from './UsageTab';
import { VerticalStats, WireCounts } from '@/types';

interface SettingsTabProps {
  verticals: string[];
  stats: VerticalStats[];
  wireCounts: WireCounts[];
  onNavigateToQueue: (wire: string) => void;
}

type SettingsSection = 'sources' | 'distribution' | 'integrations' | 'email' | 'providers' | 'usage';

const SECTIONS: { key: SettingsSection; label: string; icon: string; description: string }[] = [
  { key: 'sources', label: 'SOURCES', icon: '🛰️', description: 'Wire health & scan metrics' },
  { key: 'distribution', label: 'DISTRIBUTION', icon: '📢', description: 'Telegram live — Discord/Slack unused' },
  { key: 'providers', label: 'API PROVIDERS', icon: '🔑', description: 'API keys & credentials' },
  { key: 'usage', label: 'USAGE', icon: '📊', description: 'API costs & token usage' },
  { key: 'integrations', label: 'INTEGRATIONS', icon: '🔗', description: 'Notion CRM sync' },
  { key: 'email', label: 'EMAIL', icon: '📧', description: 'Daily digest schedule' },
];

export function SettingsTab({ verticals, stats, wireCounts, onNavigateToQueue }: SettingsTabProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('sources');

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-base sm:text-lg font-display tracking-wider glow-text">SETTINGS</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Distribution channels, integrations, and email configuration.
        </p>
      </div>

      {/* Section pills */}
      <div className="flex flex-wrap gap-2">
        {SECTIONS.map(section => (
          <button
            key={section.key}
            onClick={() => setActiveSection(section.key)}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-display tracking-wider border transition-all ${
              activeSection === section.key
                ? 'bg-primary/10 text-primary border-primary/30 shadow-sm shadow-primary/10'
                : 'bg-card/50 text-muted-foreground border-border hover:bg-card/80 hover:text-foreground'
            }`}
          >
            <span className="text-sm">{section.icon}</span>
            <span>{section.label}</span>
            <span className="hidden sm:inline text-[10px] opacity-60">— {section.description}</span>
          </button>
        ))}
      </div>

      {/* Section content */}
      <div className="min-h-[400px]">
        {activeSection === 'sources' && (
          <SourcesTab stats={stats} wireCounts={wireCounts} onNavigateToQueue={onNavigateToQueue} />
        )}
        {activeSection === 'distribution' && (
          <DistributionTab verticals={verticals} />
        )}
        {activeSection === 'providers' && (
          <ProvidersTab />
        )}
        {activeSection === 'usage' && (
          <UsageTab />
        )}
        {activeSection === 'integrations' && (
          <IntegrationsTab />
        )}
        {activeSection === 'email' && (
          <div className="max-w-lg">
            <DailyDigestCard />
          </div>
        )}
      </div>
    </div>
  );
}
