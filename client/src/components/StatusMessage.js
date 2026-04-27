import React from 'react';
import './StatusMessage.css';

export default function StatusMessage({ kind = 'info', children, className = '' }) {
  const classes = ['status-msg', `status-msg--${kind}`, className].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      {children}
    </div>
  );
}
