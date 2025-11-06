import React, { useState, useRef } from 'react';
import './ZigzagMerger.css';

const ZigzagMerger = () => {
  const [coverPage, setCoverPage] = useState(null);
  const [oldPdf, setOldPdf] = useState(null);
  const [newPdf, setNewPdf] = useState(null);
  const [zigzagPdf, setZigzagPdf] = useState(null);
  const [isMerging, setIsMerging] = useState(false);
  const [isUnzigzagging, setIsUnzigzagging] = useState(false);
  const [mergeStatus, setMergeStatus] = useState('');
  const [unzigzagStatus, setUnzigzagStatus] = useState('');
  const [unzigzagFiles, setUnzigzagFiles] = useState([]);
  const coverPageInputRef = useRef(null);
  const oldPdfInputRef = useRef(null);
  const newPdfInputRef = useRef(null);
  const zigzagPdfInputRef = useRef(null);

  const handleCoverPageUpload = (event) => {
    const file = event.target.files[0];
    if (file && file.type === 'application/pdf') {
      setCoverPage(file);
    } else {
      alert('Please select a valid PDF file.');
    }
  };

  const handleOldPdfUpload = (event) => {
    const file = event.target.files[0];
    if (file && file.type === 'application/pdf') {
      setOldPdf(file);
    } else {
      alert('Please select a valid PDF file.');
    }
  };

  const handleNewPdfUpload = (event) => {
    const file = event.target.files[0];
    if (file && file.type === 'application/pdf') {
      setNewPdf(file);
    } else {
      alert('Please select a valid PDF file.');
    }
  };

  const handleZigzagPdfUpload = (event) => {
    const file = event.target.files[0];
    if (file && file.type === 'application/pdf') {
      setZigzagPdf(file);
    } else {
      alert('Please select a valid PDF file.');
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e, setFile, inputRef) => {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') {
      setFile(file);
      if (inputRef.current) {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        inputRef.current.files = dataTransfer.files;
      }
    } else {
      alert('Please drop a valid PDF file.');
    }
  };

  const zigzagMerge = async () => {
    if (!oldPdf || !newPdf) {
      alert('Please upload both old and new PDF files.');
      return;
    }

    setIsMerging(true);
    setMergeStatus('Merging PDFs...');

    const formData = new FormData();
    if (coverPage) {
      formData.append('coverPage', coverPage);
    }
    formData.append('oldPdf', oldPdf);
    formData.append('newPdf', newPdf);

    try {
      const response = await fetch('/api/zigzag-merge', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error('Failed to merge PDFs');
      }

      const result = await response.json();
      setMergeStatus('PDFs merged successfully!');
      
      // Download the merged PDF
      downloadFile(result.filename, 'zigzag-merged.pdf');

    } catch (error) {
      console.error('Error merging PDFs:', error);
      setMergeStatus(`Error: ${error.message}`);
    } finally {
      setIsMerging(false);
    }
  };

  const unzigzag = async () => {
    if (!zigzagPdf) {
      alert('Please upload a zigzagged PDF file.');
      return;
    }

    setIsUnzigzagging(true);
    setUnzigzagStatus('Splitting PDF...');

    const formData = new FormData();
    formData.append('zigzagPdf', zigzagPdf);

    try {
      const response = await fetch('/api/unzigzag', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error('Failed to unzigzag PDF');
      }

      const result = await response.json();
      setUnzigzagFiles(result.files || []);
      setUnzigzagStatus('PDF split successfully!');

    } catch (error) {
      console.error('Error unzigzagging PDF:', error);
      setUnzigzagStatus(`Error: ${error.message}`);
    } finally {
      setIsUnzigzagging(false);
    }
  };

  const downloadFile = (filename, downloadName) => {
    const link = document.createElement('a');
    link.href = `/api/download-pdf/${encodeURIComponent(filename)}`;
    link.download = downloadName || filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const clearMerge = () => {
    setCoverPage(null);
    setOldPdf(null);
    setNewPdf(null);
    setMergeStatus('');
    if (coverPageInputRef.current) {
      coverPageInputRef.current.value = '';
    }
    if (oldPdfInputRef.current) {
      oldPdfInputRef.current.value = '';
    }
    if (newPdfInputRef.current) {
      newPdfInputRef.current.value = '';
    }
  };

  const clearUnzigzag = () => {
    setZigzagPdf(null);
    setUnzigzagStatus('');
    setUnzigzagFiles([]);
    if (zigzagPdfInputRef.current) {
      zigzagPdfInputRef.current.value = '';
    }
  };

  const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="zigzag-merger">
      <div className="merger-header">
        <h2>📄 Zigzag PDF Merger</h2>
        <p>Merge two PDFs by alternating pages: old page 1, new page 1, old page 2, new page 2, etc.</p>
      </div>

      <div className="merger-container">
        <div className="left-section">
          <div className="merge-section">
            <h3>📎 Zigzag Merge</h3>
            
            <div className="upload-group">
              <label className="upload-label">Cover Page (Optional)</label>
              <div 
                className="upload-area"
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, setCoverPage, coverPageInputRef)}
                onClick={() => coverPageInputRef.current?.click()}
              >
                <input
                  type="file"
                  ref={coverPageInputRef}
                  onChange={handleCoverPageUpload}
                  accept="application/pdf"
                  className="file-input"
                />
                <div className="upload-placeholder">
                  <div className="upload-icon">📄</div>
                  <p>{coverPage ? coverPage.name : 'Click to select or drag & drop (optional)'}</p>
                  {coverPage && (
                    <p className="file-size-text">{formatFileSize(coverPage.size)}</p>
                  )}
                </div>
              </div>
            </div>

            <div className="upload-group">
              <label className="upload-label">Old PDF</label>
              <div 
                className="upload-area"
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, setOldPdf, oldPdfInputRef)}
                onClick={() => oldPdfInputRef.current?.click()}
              >
                <input
                  type="file"
                  ref={oldPdfInputRef}
                  onChange={handleOldPdfUpload}
                  accept="application/pdf"
                  className="file-input"
                />
                <div className="upload-placeholder">
                  <div className="upload-icon">📄</div>
                  <p>{oldPdf ? oldPdf.name : 'Click to select or drag & drop'}</p>
                  {oldPdf && (
                    <p className="file-size-text">{formatFileSize(oldPdf.size)}</p>
                  )}
                </div>
              </div>
            </div>

            <div className="upload-group">
              <label className="upload-label">New PDF</label>
              <div 
                className="upload-area"
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, setNewPdf, newPdfInputRef)}
                onClick={() => newPdfInputRef.current?.click()}
              >
                <input
                  type="file"
                  ref={newPdfInputRef}
                  onChange={handleNewPdfUpload}
                  accept="application/pdf"
                  className="file-input"
                />
                <div className="upload-placeholder">
                  <div className="upload-icon">📄</div>
                  <p>{newPdf ? newPdf.name : 'Click to select or drag & drop'}</p>
                  {newPdf && (
                    <p className="file-size-text">{formatFileSize(newPdf.size)}</p>
                  )}
                </div>
              </div>
            </div>

            <button 
              className="merge-btn"
              onClick={zigzagMerge}
              disabled={isMerging || !oldPdf || !newPdf}
            >
              {isMerging ? 'Merging...' : '🔄 Zigzag Merge'}
            </button>

            {mergeStatus && (
              <div className="status-message">
                <p>{mergeStatus}</p>
              </div>
            )}

            <button 
              className="clear-btn"
              onClick={clearMerge}
              disabled={isMerging}
            >
              🗑️ Clear
            </button>
          </div>
        </div>

        <div className="right-section">
          <div className="unzigzag-section">
            <h3>✂️ Unzigzag</h3>
            
            <div className="upload-group">
              <label className="upload-label">Zigzagged PDF</label>
              <div 
                className="upload-area"
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, setZigzagPdf, zigzagPdfInputRef)}
                onClick={() => zigzagPdfInputRef.current?.click()}
              >
                <input
                  type="file"
                  ref={zigzagPdfInputRef}
                  onChange={handleZigzagPdfUpload}
                  accept="application/pdf"
                  className="file-input"
                />
                <div className="upload-placeholder">
                  <div className="upload-icon">📄</div>
                  <p>{zigzagPdf ? zigzagPdf.name : 'Click to select or drag & drop'}</p>
                  {zigzagPdf && (
                    <p className="file-size-text">{formatFileSize(zigzagPdf.size)}</p>
                  )}
                </div>
              </div>
            </div>

            <button 
              className="merge-btn"
              onClick={unzigzag}
              disabled={isUnzigzagging || !zigzagPdf}
            >
              {isUnzigzagging ? 'Splitting...' : '✂️ Unzigzag'}
            </button>

            {unzigzagStatus && (
              <div className="status-message">
                <p>{unzigzagStatus}</p>
              </div>
            )}

            {unzigzagFiles.length > 0 && (
              <div className="results-section">
                <h4>✅ Split Files ({unzigzagFiles.length})</h4>
                <div className="split-files">
                  {unzigzagFiles.map((filename, index) => (
                    <div key={index} className="split-file-item">
                      <span>{filename}</span>
                      <button 
                        className="download-btn"
                        onClick={() => downloadFile(filename)}
                      >
                        📥 Download
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <button 
              className="clear-btn"
              onClick={clearUnzigzag}
              disabled={isUnzigzagging}
            >
              🗑️ Clear
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ZigzagMerger;

