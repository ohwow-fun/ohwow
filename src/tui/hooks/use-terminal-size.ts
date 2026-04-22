import { useState, useEffect } from 'react';

/** Returns live terminal column count, updates on resize. */
export function useTerminalSize(): number {
  const [cols, setCols] = useState(() => process.stdout.columns || 80);

  useEffect(() => {
    const handler = () => setCols(process.stdout.columns || 80);
    process.stdout.on('resize', handler);
    return () => { process.stdout.off('resize', handler); };
  }, []);

  return cols;
}
