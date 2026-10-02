import { Settings } from 'lucide-react';
import { useState } from 'react';
import SettingsDialogue from './SettingsDialogue';
import { AnimatePresence } from 'framer-motion';

const SettingsButtonMobile = () => {
  const [isOpen, setIsOpen] = useState<boolean>(false);

  return (
    <>
      <button
        type="button"
        aria-label="Open settings"
        className="lg:hidden flex min-h-11 min-w-11 items-center justify-center rounded-full bg-light-secondary dark:bg-dark-secondary text-black/80 dark:text-white/80"
        onClick={() => setIsOpen(true)}
      >
        <Settings size={18} />
      </button>
      <AnimatePresence>
        {isOpen && <SettingsDialogue isOpen={isOpen} setIsOpen={setIsOpen} />}
      </AnimatePresence>
    </>
  );
};

export default SettingsButtonMobile;
