'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ListFilter, Users } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function ContactsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  const items = [
    { href: '/contacts', label: 'Contacts', icon: Users, exact: true },
    { href: '/contacts/segments', label: 'Smart Lists', icon: ListFilter, exact: false },
  ];

  return (
    <div className="space-y-5">
      <div className="inline-flex rounded-lg border border-border bg-card p-1">
        {items.map((item) => {
          const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                active
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icon className="size-4" />
              {item.label}
            </Link>
          );
        })}
      </div>
      {children}
    </div>
  );
}
