import { cn } from '@/lib/utils';
import { Mail, MessageSquare, Twitter, Send, Newspaper } from 'lucide-react';

interface DistributionBadgesProps {
  channels: string[];
  className?: string;
}

const channelIcons: Record<string, typeof Mail> = {
  email: Mail,
  slack: MessageSquare,
  discord: MessageSquare,
  twitter: Twitter,
  newsletter: Newspaper,
};

export function DistributionBadges({ channels, className }: DistributionBadgesProps) {
  if (!channels || channels.length === 0) {
    return <span className="text-muted-foreground text-sm font-mono">—</span>;
  }

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      {channels.map(channel => {
        const Icon = channelIcons[channel.toLowerCase()] || Send;
        return (
          <span
            key={channel}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-primary/10 text-primary text-[10px] border border-primary/20 font-mono uppercase"
            title={channel}
          >
            <Icon className="w-3 h-3" />
            {channel}
          </span>
        );
      })}
    </div>
  );
}
