import React from 'react';
import TraderGlanceCard from './TraderGlanceCard';
import ToolGrid from './ToolGrid';
import './HomePage.css';

export default function HomePage() {
  return (
    <div className="home">
      <TraderGlanceCard />
      <div className="home-spacer" aria-hidden />
      <ToolGrid />
    </div>
  );
}
