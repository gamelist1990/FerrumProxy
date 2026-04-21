import React from 'react';
import './UI.css';

interface CardProps {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export const Card: React.FC<CardProps> = ({ title, actions, children, className = '' }) => {
  return (
    <div className={`ui-card ${className}`}>
      {(title || actions) && (
        <div className="ui-card-header">
          <div className="ui-card-title">{title}</div>
          <div className="ui-card-actions">{actions}</div>
        </div>
      )}
      <div className="ui-card-body">{children}</div>
    </div>
  );
};
