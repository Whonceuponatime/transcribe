import React, { useState, useRef } from 'react';
import './MarkdownCSVConverter.css';

const MarkdownCSVConverter = () => {
  const [inputText, setInputText] = useState('');
  const [inputType, setInputType] = useState('markdown'); // 'markdown' or 'csv'
  const [outputText, setOutputText] = useState('');
  const [delimiter, setDelimiter] = useState(',');
  const [hasHeaders, setHasHeaders] = useState(true);
  const [copyToast, setCopyToast] = useState(false);
  const textareaRef = useRef(null);
  const outputRef = useRef(null);

  // Convert Markdown table to TSV (Excel copy-pastable)
  const convertMarkdownToExcel = (markdown) => {
    const lines = markdown.split('\n').filter(line => line.trim());
    const rows = [];

    for (const line of lines) {
      // Check if it's a markdown table row (starts with |)
      if (line.trim().startsWith('|')) {
        // Remove leading/trailing | and split by |
        const cells = line
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map(cell => cell.trim());
        
        // Skip separator rows (like |---|---|)
        if (!cells.every(cell => /^[-:]+$/.test(cell))) {
          rows.push(cells);
        }
      }
    }

    // Convert to TSV format (tab-separated values)
    return rows.map(row => row.join('\t')).join('\n');
  };

  // Convert CSV to TSV (Excel copy-pastable)
  const convertCSVToExcel = (csv, delimiter) => {
    const lines = csv.split('\n').filter(line => line.trim());
    const rows = [];

    for (const line of lines) {
      // Simple CSV parsing (handles quoted fields)
      const cells = [];
      let currentCell = '';
      let inQuotes = false;

      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const nextChar = line[i + 1];

        if (char === '"') {
          if (inQuotes && nextChar === '"') {
            // Escaped quote
            currentCell += '"';
            i++; // Skip next quote
          } else {
            // Toggle quote state
            inQuotes = !inQuotes;
          }
        } else if (char === delimiter && !inQuotes) {
          // End of cell
          cells.push(currentCell.trim());
          currentCell = '';
        } else {
          currentCell += char;
        }
      }
      // Add last cell
      cells.push(currentCell.trim());
      rows.push(cells);
    }

    // Convert to TSV format (tab-separated values)
    return rows.map(row => row.join('\t')).join('\n');
  };

  const handleConvert = () => {
    if (!inputText.trim()) {
      alert('Please enter some text to convert.');
      return;
    }

    try {
      let result = '';
      if (inputType === 'markdown') {
        result = convertMarkdownToExcel(inputText);
      } else {
        result = convertCSVToExcel(inputText, delimiter);
      }

      if (!result.trim()) {
        alert('No valid data found. Please check your input format.');
        return;
      }

      setOutputText(result);
    } catch (error) {
      console.error('Conversion error:', error);
      alert(`Conversion failed: ${error.message}`);
    }
  };

  const handleCopy = () => {
    if (!outputText) return;
    navigator.clipboard.writeText(outputText).then(() => {
      setCopyToast(true);
      setTimeout(() => setCopyToast(false), 2500);
    }).catch(() => {});
  };

  const handleClear = () => {
    setInputText('');
    setOutputText('');
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  };

  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target.result;
      setInputText(content);
      
      // Auto-detect file type
      if (file.name.endsWith('.csv')) {
        setInputType('csv');
      } else if (file.name.endsWith('.md') || file.name.endsWith('.markdown')) {
        setInputType('markdown');
      }
    };
    reader.readAsText(file);
  };

  const handleExample = () => {
    if (inputType === 'markdown') {
      setInputText(`| Name | Age | City |
|------|-----|------|
| John | 25  | NYC  |
| Jane | 30  | LA   |
| Bob  | 35  | Chicago |`);
    } else {
      setInputText(`Name,Age,City
John,25,NYC
Jane,30,LA
Bob,35,Chicago`);
    }
  };

  return (
    <div className="markdown-csv-converter">
      <div className="converter-header">
        <h2>📊 Markdown/CSV to Excel Converter</h2>
        <p>Convert Markdown tables or CSV files to Excel copy-pastable format (TSV)</p>
      </div>

      <div className="converter-container">
        <div className="left-section">
          <div className="input-section">
            <div className="input-header">
              <h3>📝 Input</h3>
              <div className="input-type-selector">
                <label>
                  <input
                    type="radio"
                    value="markdown"
                    checked={inputType === 'markdown'}
                    onChange={(e) => setInputType(e.target.value)}
                  />
                  Markdown Table
                </label>
                <label>
                  <input
                    type="radio"
                    value="csv"
                    checked={inputType === 'csv'}
                    onChange={(e) => setInputType(e.target.value)}
                  />
                  CSV
                </label>
              </div>
            </div>

            {inputType === 'csv' && (
              <div className="csv-settings">
                <label>
                  Delimiter:
                  <select value={delimiter} onChange={(e) => setDelimiter(e.target.value)}>
                    <option value=",">Comma (,)</option>
                    <option value=";">Semicolon (;)</option>
                    <option value="\t">Tab</option>
                    <option value="|">Pipe (|)</option>
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={hasHeaders}
                    onChange={(e) => setHasHeaders(e.target.checked)}
                  />
                  First row is header
                </label>
              </div>
            )}

            <div className="input-actions">
              <button onClick={handleExample} className="example-btn">
                📋 Load Example
              </button>
              <label className="upload-btn">
                📁 Upload File
                <input
                  type="file"
                  accept={inputType === 'csv' ? '.csv' : '.md,.markdown'}
                  onChange={handleFileUpload}
                  style={{ display: 'none' }}
                />
              </label>
            </div>

            <textarea
              ref={textareaRef}
              className="input-textarea"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={inputType === 'markdown' 
                ? 'Paste your Markdown table here...\n\nExample:\n| Name | Age | City |\n|------|-----|------|\n| John | 25  | NYC  |'
                : 'Paste your CSV data here...\n\nExample:\nName,Age,City\nJohn,25,NYC\nJane,30,LA'}
              rows={15}
            />
          </div>
        </div>

        <div className="right-section">
          <div className="output-section">
            <div className="output-header">
              <h3>📋 Excel-Ready Output (TSV)</h3>
              <div className="output-actions">
                <button onClick={handleConvert} className="convert-btn">
                  🔄 Convert
                </button>
                <button onClick={handleCopy} className="copy-btn" disabled={!outputText}>
                  📋 Copy to Clipboard
                </button>
                <button onClick={handleClear} className="clear-btn">
                  🗑️ Clear
                </button>
              </div>
            </div>

            <textarea
              ref={outputRef}
              className="output-textarea"
              value={outputText}
              readOnly
              placeholder="Converted output will appear here (TSV – paste into Excel)."
              rows={15}
              style={{ whiteSpace: 'pre-wrap' }}
            />

            {copyToast && (
              <div className="copy-toast" role="status">
                ✓ Copied to clipboard
              </div>
            )}

            {outputText && (
              <div className="output-info">
                <p>✅ Conversion complete! Click "Copy to Clipboard" and paste into Excel.</p>
                <p className="hint">💡 Tip: In Excel, paste using Ctrl+V. The data will automatically be separated into columns.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MarkdownCSVConverter;


