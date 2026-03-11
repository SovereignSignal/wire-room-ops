import { useState } from 'react';
import { DistributionTab } from './DistributionTab';
import { IntegrationsTab } from './IntegrationsTab';
import { DailyDigestCard } from './DailyDigestCard';

interface SettingsTabProps {
  verticals: string[];
}

type SettingsSection = 'distribution' | 'integrations' | 'email';

const SECTIONS: { key: SettingsSection; label: string; icon: string; description: string }[] = [
  { key: 'distribution', label: 'DISTRIBUTION', icon: '📢', description: 'Telegram, Discord, Slack channels' },
  { key: 'integrations', label: 'INTEGRATIONS', icon: '🔗', description: 'Notion CRM sync' },
  { key: 'email', label: 'EMAIL', icon: '📧', description: 'Daily digest schedule' },
];

export function SettingsTab({ verticals }: SettingsTabProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('distribution');

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
        {activeSection === 'distribution' && (
          <DistributionTab verticals={verticals} />
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
