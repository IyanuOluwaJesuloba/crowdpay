import React, { useState } from 'react';

export default function CampaignForm({ initialData = {}, onSubmit }) {
  const [deadline, setDeadline] = useState(initialData.deadline ? initialData.deadline.slice(0, 16) : '');
  const [title, setTitle] = useState(initialData.title || '');
  const [targetAmount, setTargetAmount] = useState(initialData.target_amount || '');

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16);

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit({ title, target_amount: targetAmount, deadline: deadline ? new Date(deadline).toISOString() : null });
  };

  return (
    <form onSubmit={handleSubmit}>
      <div>
        <label>Title</label>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div>
        <label>Target Amount</label>
        <input type="number" value={targetAmount} onChange={(e) => setTargetAmount(e.target.value)} required />
      </div>
      <div>
        <label>Deadline</label>
        <input
          type="datetime-local"
          min={tomorrow}
          value={deadline}
          onChange={(e) => setDeadline(e.target.value)}
          required
        />
      </div>
      <button type="submit">Save Campaign</button>
    </form>
  );
}