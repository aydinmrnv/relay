'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import type { AccountUser } from '@/lib/cloud/types';
import { cn } from '@/lib/utils';

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length >= 2 ? `${parts[0]![0]}${parts[parts.length - 1]![0]}` : (parts[0]?.slice(0, 2) ?? '?');
  return letters.toUpperCase();
}

export function UserAvatar({ user, size = 'default', className }: { user: Pick<AccountUser, 'name' | 'image'>; size?: 'default' | 'sm' | 'lg'; className?: string }) {
  return (
    <Avatar size={size} className={cn('rounded-lg after:rounded-lg', className)}>
      {user.image === null ? null : <AvatarImage src={user.image} alt="" className="rounded-lg" />}
      <AvatarFallback className="rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 font-medium text-white">{initials(user.name)}</AvatarFallback>
    </Avatar>
  );
}
