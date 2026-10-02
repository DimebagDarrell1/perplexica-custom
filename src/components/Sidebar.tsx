'use client';

import { cn } from '@/lib/utils';
import { BookOpenText, Home, Search, Plus } from 'lucide-react';
import Link from 'next/link';
import { useSelectedLayoutSegments } from 'next/navigation';
import React, { type ReactNode } from 'react';
import Layout from './Layout';
import SettingsButton from './Settings/SettingsButton';
import BuildLabel from './BuildLabel';

const VerticalIconContainer = ({ children }: { children: ReactNode }) => {
  return (
    <nav
      aria-label="Main navigation"
      className="flex flex-col items-center w-full"
    >
      {children}
    </nav>
  );
};

const Sidebar = ({ children }: { children: React.ReactNode }) => {
  const segments = useSelectedLayoutSegments();

  const navLinks = [
    {
      icon: Home,
      href: '/',
      active: segments.length === 0 || segments.includes('c'),
      label: 'Home',
    },
    {
      icon: Search,
      href: '/discover',
      active: segments.includes('discover'),
      label: 'Discover',
    },
    {
      icon: BookOpenText,
      href: '/library',
      active: segments.includes('library'),
      label: 'Library',
    },
  ];

  return (
    <div>
      <div className="hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:w-[72px] lg:flex-col border-r border-light-200 dark:border-dark-200">
        <div className="flex grow flex-col items-center justify-between gap-y-5 overflow-y-auto bg-light-secondary dark:bg-dark-secondary px-2 py-8 shadow-sm shadow-light-200/10 dark:shadow-black/25">
          {/* A new chat needs a full reload to reset the shared chat provider. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            aria-label="New chat"
            title="New chat"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-full bg-accent text-white hover:opacity-90 transition duration-200"
            href="/"
          >
            <Plus size={19} className="cursor-pointer" />
          </a>
          <VerticalIconContainer>
            {navLinks.map((link, i) => (
              <Link
                key={i}
                href={link.href}
                aria-current={link.active ? 'page' : undefined}
                className={cn(
                  'relative flex flex-col items-center justify-center space-y-0.5 cursor-pointer w-full py-2 rounded-lg',
                  link.active
                    ? 'text-accent dark:text-accent-dark'
                    : 'text-black/60 dark:text-white/60',
                )}
              >
                <div
                  className={cn(
                    link.active && 'bg-accent/10 dark:bg-accent-dark/10',
                    'group rounded-lg hover:bg-light-200 hover:dark:bg-dark-200 transition duration-200',
                  )}
                >
                  <link.icon
                    size={25}
                    className={cn(
                      !link.active && 'group-hover:scale-105',
                      'transition duration:200 m-1.5',
                    )}
                  />
                </div>
                <p
                  className={cn(
                    link.active
                      ? 'text-accent dark:text-accent-dark'
                      : 'text-black/60 dark:text-white/60',
                    'text-[10px]',
                  )}
                >
                  {link.label}
                </p>
              </Link>
            ))}
          </VerticalIconContainer>

          <div className="flex flex-col items-center gap-3">
            <SettingsButton />
            <BuildLabel compact />
          </div>
        </div>
      </div>

      <nav
        aria-label="Main navigation"
        className="fixed bottom-0 w-full z-50 flex flex-row items-center gap-x-6 bg-light-secondary dark:bg-dark-secondary px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] border-t border-light-200 dark:border-dark-200 lg:hidden"
      >
        {navLinks.map((link, i) => (
          <Link
            href={link.href}
            aria-current={link.active ? 'page' : undefined}
            key={i}
            className={cn(
              'relative flex flex-col items-center justify-center min-h-11 space-y-1 text-center w-full',
              link.active
                ? 'text-accent dark:text-accent-dark'
                : 'text-black dark:text-white/70',
            )}
          >
            {link.active && (
              <div className="absolute top-0 -mt-4 h-1 w-full rounded-b-lg bg-accent dark:bg-accent-dark" />
            )}
            <link.icon />
            <p className="text-xs">{link.label}</p>
          </Link>
        ))}
      </nav>

      <Layout>{children}</Layout>
    </div>
  );
};

export default Sidebar;
