import { cn } from '@/lib/utils';

interface ScoreBadgeProps {
  score: number;
  className?: string;
}

export function ScoreBadge({ score, className }: ScoreBadgeProps) {
  const getScoreClass = (score: number) => {
    if (score >= 70) return 'score-high';
    if (score >= 50) return 'score-medium';
    return 'score-low';
  };

  return (
    <span 
      className={cn(
        'inline-flex items-center justify-center px-2 py-0.5 rounded text-xs font-mono font-medium min-w-[2.5rem]',
        getScoreClass(score),
        className
      )}
    >
      {score}
    </span>
  );
}
