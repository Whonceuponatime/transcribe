import React from 'react';
import './StatusMessage.css';

export default function Spinner({ size = 16, label }) {
  const ringStyle = { width: size, height: size };
  if (!label) {
    return <span className="status-spinner" style={ringStyle} aria-label="Loading" />;
  }
  return (
    <span className="status-spinner-wrap">
      <span className="status-spinner" style={ringStyle} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
