import React, { useState, useEffect } from 'react';
import './FileAnalysis.css';

const FileAnalysis = () => {
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState('');
  const [processedFiles, setProcessedFiles] = useState([]);
  const [error, setError] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [processingStatus, setProcessingStatus] = useState('');
  const [directoryTree, setDirectoryTree] = useState('');
  const [useManualTree, setUseManualTree] = useState(false);
  const [completedFiles, setCompletedFiles] = useState([]);
  const [currentBatch, setCurrentBatch] = useState('');
  const [totalBatches, setTotalBatches] = useState(0);
  


  const handleFileSelect = (event) => {
    const files = Array.from(event.target.files);
    const validFiles = files.filter(file => 
      file.type === 'text/plain' || 
      file.type === 'text/markdown' || 
      file.name.endsWith('.txt') || 
      file.name.endsWith('.md')
    );

    if (validFiles.length > 0) {
      setSelectedFiles(validFiles);
      setError('');
    } else {
      setError('Please select text or markdown files (.txt, .md)');
      setSelectedFiles([]);
    }
  };

  const handleDirectorySelect = (event) => {
    const files = Array.from(event.target.files);
    console.log('Directory files selected:', files.length);
    console.log('File names:', files.map(f => f.name));
    console.log('Sample file webkitRelativePath:', files[0]?.webkitRelativePath);
    console.log('Sample file path:', files[0]?.path);
    
    // Check if directory upload is supported
    if (files.length === 0) {
      setError('Directory upload not supported in this browser. Please use "Upload Individual Files" and select all files manually.');
      return;
    }
    
    const validFiles = files.filter(file => 
      file.name.endsWith('.txt') || 
      file.name.endsWith('.md')
    );

    console.log('Valid files found:', validFiles.length);

    if (validFiles.length > 0) {
      // Create a map of file paths to preserve directory structure
      const filesWithPaths = validFiles.map(file => {
        // Extract the relative path from the file's webkitRelativePath
        const relativePath = file.webkitRelativePath || file.name;
        console.log(`File: ${file.name} -> webkitRelativePath: ${file.webkitRelativePath} -> final path: ${relativePath}`);
        return {
          file: file,
          path: relativePath,
          directory: relativePath.split('/').slice(0, -1).join('/')
        };
      });

      setSelectedFiles(validFiles);
      setError('');
      
      // Log the directory structure
      console.log('Directory structure:');
      filesWithPaths.forEach(({ path, directory }) => {
        console.log(`  ${path} (in: ${directory || 'root'})`);
      });
    } else {
      setError('No valid markdown or text files found in the selected directory. Please ensure your folder contains .txt or .md files.');
      setSelectedFiles([]);
    }
  };

  const handleFileUpload = async () => {
    if (selectedFiles.length === 0) {
      setError('Please select files first');
      return;
    }

    setIsAnalyzing(true);
    setError('');
    setAnalysisResult('');
    setProcessedFiles([]);
    setUploadProgress(0);
    setProcessingStatus('Starting analysis...');

    const formData = new FormData();
    selectedFiles.forEach((file, index) => {
      formData.append('files', file);
      // Send the relative path if available
      const relativePath = file.webkitRelativePath || file.name;
      formData.append('paths', relativePath);
      console.log(`Uploading file: ${file.name} -> Path: ${relativePath}`);
    });
    
    // Add directory tree if provided manually
    if (useManualTree && directoryTree.trim()) {
      formData.append('directoryTree', directoryTree.trim());
      console.log('Adding manual directory tree to request');
    }
    
    // Log all paths being sent
    console.log('All paths being sent to server:');
    selectedFiles.forEach((file, index) => {
      const relativePath = file.webkitRelativePath || file.name;
      console.log(`  ${index + 1}. ${file.name} -> ${relativePath}`);
    });

    try {
      const response = await fetch('http://localhost:3000/api/analyze-files', {
        method: 'POST',
        body: formData,
        // Increase timeout for large file processing
        signal: AbortSignal.timeout(3600000) // 1 hour timeout
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      
      if (data.error) {
        setError(data.error);
      } else {
        setAnalysisResult(data.result);
        setProcessedFiles(data.processedFiles || []);
      }
    } catch (err) {
      if (err.name === 'TimeoutError') {
        setError('Upload timeout: The request is taking longer than expected. The server is still processing your files. Please wait and check the results section below.');
      } else if (err.name === 'AbortError') {
        setError('Upload aborted: The request was cancelled. Please try again.');
      } else {
        setError(`Upload failed: ${err.message}`);
      }
    } finally {
      setIsAnalyzing(false);
      setUploadProgress(0);
      setProcessingStatus('');
    }
  };

  const handleDownloadFile = async (filename) => {
    try {
      const response = await fetch(`http://localhost:3000/api/download-file/${encodeURIComponent(filename)}`);
      
      if (!response.ok) {
        throw new Error(`Download failed: ${response.status}`);
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      setError(`Download failed: ${err.message}`);
    }
  };

  const handleDownloadAll = async () => {
    if (processedFiles.length === 0) {
      setError('No processed files available for download');
      return;
    }

    try {
      const response = await fetch('http://localhost:3000/api/download-all-files', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ files: processedFiles }),
      });

      if (!response.ok) {
        throw new Error(`Download failed: ${response.status}`);
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'directory-structure-report.txt';
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      setAnalysisResult(prev => prev + '\n\n📥 Directory structure report downloaded! Check the file for instructions on how to restore your directory structure.');
    } catch (err) {
      setError(`Download failed: ${err.message}`);
    }
  };

  const handleClear = () => {
    setSelectedFiles([]);
    setAnalysisResult('');
    setProcessedFiles([]);
    setError('');
    setUploadProgress(0);
  };

  const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getTotalSize = () => {
    return selectedFiles.reduce((total, file) => total + file.size, 0);
  };

  // Listen for progress updates from server
  useEffect(() => {
    // Import socket.io-client dynamically
    import('socket.io-client').then(({ io }) => {
      const socket = io('http://localhost:3000');
      
      socket.on('analysisProgress', (data) => {
        console.log('Progress update:', data);
        setProcessingStatus(data.message || 'Processing...');
        setUploadProgress(data.progress || 0);
        
        // Handle completed files tracking
        if (data.completedFiles) {
          setCompletedFiles(data.completedFiles);
        }
        
        // Handle batch progress
        if (data.currentBatch && data.totalBatches) {
          setCurrentBatch(data.currentBatch);
          setTotalBatches(data.totalBatches);
        }
        
        // Handle phase progress
        if (data.phase) {
          setProcessingStatus(`Phase ${data.phase}/${data.total}: ${data.message}`);
        }
      });

      return () => {
        socket.disconnect();
      };
    });
  }, []);

  return (
    <div className="file-analysis-container">
      {console.log('FileAnalysis component rendering - test elements should be visible')}
      <div className="file-analysis-header">
        <h2>📄 File Analysis & Note Linking</h2>
        <p>Upload your Obsidian notes to automatically link related content using AI</p>
      </div>

      <div className="file-analysis-content">
        <div className="upload-section">
          <div style={{ color: 'white', marginBottom: '10px' }}>
            Debug: Upload options should be visible below
          </div>
          <div className="upload-options">
            <div className="upload-option">
              <h3>📁 Upload Individual Files</h3>
              <input
                type="file"
                id="file-input"
                accept=".txt,.md,text/plain,text/markdown"
                onChange={handleFileSelect}
                multiple
                style={{ display: 'none' }}
              />
              <label htmlFor="file-input" className="file-upload-label">
                <div className="upload-icon">📄</div>
                <div className="upload-text">Choose multiple files</div>
                <div className="upload-hint">Select multiple .txt and .md files</div>
              </label>
            </div>

            <div className="upload-option">
              <h3>📂 Upload Directory</h3>
              <input
                type="file"
                id="directory-input"
                accept=".txt,.md"
                onChange={handleDirectorySelect}
                multiple
                webkitdirectory="true"
                style={{ display: 'none' }}
              />
              <label htmlFor="directory-input" className="file-upload-label">
                <div className="upload-icon">📂</div>
                <div className="upload-text">Choose a directory</div>
                <div className="upload-hint">Select a folder with .txt and .md files</div>
              </label>
            </div>
          </div>
          
          <div className="directory-help">
            <small>💡 Tip: If directory selection doesn't work, use "Upload Individual Files" and select all files manually</small>
          </div>

          {/* SUPER PROMINENT TEST ELEMENT - This should be impossible to miss */}
          <div style={{ 
            background: 'lime', 
            color: 'black', 
            padding: '20px', 
            margin: '20px 0', 
            border: '5px solid red',
            textAlign: 'center',
            fontWeight: 'bold',
            fontSize: '18px',
            position: 'relative',
            zIndex: 9999
          }}>
            🚨🚨🚨 URGENT TEST: IF YOU SEE THIS, THE MANUAL TREE SECTION IS BELOW 🚨🚨🚨
          </div>

          {/* TEST ELEMENT - This should always be visible */}
          <div style={{ 
            background: 'red', 
            color: 'white', 
            padding: '10px', 
            margin: '10px 0', 
            border: '2px solid yellow',
            textAlign: 'center',
            fontWeight: 'bold'
          }}>
            🚨 TEST: Manual Tree Section Should Be Below This 🚨
          </div>

          <div className="manual-tree-section">
            <h3 style={{ color: 'white', marginBottom: '15px', textAlign: 'center' }}>
              🔧 Manual Directory Tree Input
            </h3>
            <div className="tree-toggle">
              <label>
                <input
                  type="checkbox"
                  checked={useManualTree}
                  onChange={(e) => {
                    console.log('Tree toggle changed:', e.target.checked);
                    setUseManualTree(e.target.checked);
                  }}
                />
                📁 Use Manual Directory Tree (if directory upload fails)
              </label>
            </div>
            
            {useManualTree && (
              <div className="tree-input-container">
                <label htmlFor="directory-tree">Paste your directory tree structure:</label>
                <textarea
                  id="directory-tree"
                  value={directoryTree}
                  onChange={(e) => setDirectoryTree(e.target.value)}
                  placeholder="Paste the output of 'tree . /F' command here..."
                  rows={10}
                  className="tree-textarea"
                />
                <small>💡 Copy the output of <code>tree . /F</code> command from your directory</small>
              </div>
            )}
          </div>
          
          {/* Debug info */}
          <div style={{ color: 'white', marginTop: '10px', fontSize: '12px' }}>
            Debug: useManualTree = {useManualTree.toString()}, directoryTree length = {directoryTree.length}
          </div>

          {selectedFiles.length > 0 && (
            <div className="files-info">
              <h3>📋 Selected Files ({selectedFiles.length})</h3>
              <div className="files-list">
                {selectedFiles.map((file, index) => (
                  <div key={index} className="file-item">
                    <span className="file-name">{file.name}</span>
                    <span className="file-size">{formatFileSize(file.size)}</span>
                  </div>
                ))}
              </div>
              <div className="total-info">
                <strong>Total size:</strong> {formatFileSize(getTotalSize())}
              </div>
            </div>
          )}

          {error && (
            <div className="error-message">
              ❌ {error}
              {error.includes('timeout') && (
                <div style={{ marginTop: '10px' }}>
                  <button 
                    className="check-results-button"
                    onClick={() => {
                      setError('');
                      setProcessingStatus('Checking for completed files...');
                      // The server might have completed processing even if the request timed out
                      setTimeout(() => {
                        setProcessingStatus('');
                      }, 3000);
                    }}
                  >
                    🔍 Check if files are ready
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="action-buttons">
            <button
              className="analyze-button"
              onClick={handleFileUpload}
              disabled={selectedFiles.length === 0 || isAnalyzing}
            >
              {isAnalyzing ? '🔍 Analyzing...' : `🔍 Analyze ${selectedFiles.length} File${selectedFiles.length !== 1 ? 's' : ''}`}
            </button>
            <button
              className="clear-button"
              onClick={handleClear}
              disabled={isAnalyzing}
            >
              🗑️ Clear
            </button>
          </div>

          {isAnalyzing && (
            <div className="progress-container">
              <div className="progress-bar">
                <div 
                  className="progress-fill"
                  style={{ width: `${uploadProgress}%` }}
                ></div>
              </div>
              <p>{processingStatus || 'Processing your files...'}</p>
              <p><small>This may take several minutes due to rate limits. Processing in batches of 2 files with 30-second delays.</small></p>
              
              {/* Completed Files Tracking */}
              {completedFiles.length > 0 && (
                <div className="completed-files-section">
                  <h4>✅ Completed Files ({completedFiles.length}/{selectedFiles.length})</h4>
                  <div className="completed-files-list">
                    {completedFiles.map((file, index) => (
                      <div key={index} className="completed-file-item">
                        <span className="completed-file-icon">✅</span>
                        <span className="completed-file-name">{file}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {/* Current Batch Info */}
              {currentBatch && totalBatches > 0 && (
                <div className="batch-info">
                  <p><strong>Current Batch:</strong> {currentBatch} of {totalBatches}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {analysisResult && (
          <div className="results-section">
            <h3>📋 Analysis Results</h3>
            <div className="results-content">
              <div className="results-text">
                <h4>Linked Notes:</h4>
                <div className="linked-notes">
                  {analysisResult}
                </div>
              </div>
              
              {processedFiles.length > 0 && (
                <div className="download-section">
                  <h4>📥 Download Processed Files</h4>
                  <div className="download-options">
                    <button 
                      className="download-all-button"
                      onClick={handleDownloadAll}
                    >
                      📦 Download Directory Structure Report
                    </button>
                    <div className="individual-downloads">
                      <h5>Download Individual Files:</h5>
                      <div className="download-list">
                        {processedFiles.map((file, index) => (
                          <div key={index} className="download-item">
                            <span className="download-filename">{file}</span>
                            <button 
                              className="download-single-button"
                              onClick={() => handleDownloadFile(file)}
                            >
                              📄 Download
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default FileAnalysis; 