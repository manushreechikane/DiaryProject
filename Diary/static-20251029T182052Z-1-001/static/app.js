
document.addEventListener('DOMContentLoaded', () => {
    
    if (typeof CryptoJS === 'undefined' || typeof Quill === 'undefined') {
        console.error("CRITICAL ERROR: Missing CryptoJS or Quill library. Check index.html imports.");
        return;
    }

    // --- Global State ---
    let masterKey = null; // The derived encryption key 
    let currentEntry = null; 
    let allEntries = []; 

    // --- DOM Elements ---
    const entryListElement = document.getElementById('entryList');
    const entryEditorElement = document.getElementById('entryEditor');
    const loadingSpinner = document.getElementById('loadingSpinner');
    const newEntryBtn = document.getElementById('newEntryBtn');
    const saveEntryBtn = document.getElementById('saveEntryBtn');
    const cancelEditBtn = document.getElementById('cancelEditBtn');
    const deleteEntryBtn = document.getElementById('deleteEntryBtn');
    const searchInput = document.getElementById('searchInput');
    const searchBtn = document.getElementById('searchBtn');
    const dateInput = document.getElementById('dateInput');
    const entryTitleInput = document.getElementById('entryTitleInput'); 

    // Modals
    const passwordModal = document.getElementById('passwordModal');
    const masterPasswordInput = document.getElementById('masterPassword');
    const setPasswordBtn = document.getElementById('setPasswordBtn');

    const confirmModal = document.getElementById('confirmModal');
    const confirmTitle = document.getElementById('confirmTitle');
    const confirmMessage = document.getElementById('confirmMessage');
    let confirmYesBtn; 
    let confirmNoBtn; 
    
    
    const quill = new Quill('#entryContent', {
        theme: 'snow',
        placeholder: 'Write your thoughts here...',
        modules: {
            toolbar: [
                [{ 'header': [1, 2, false] }],
                ['bold', 'italic', 'underline', 'strike'],
                ['blockquote', 'code-block'],
                [{ 'list': 'ordered'}, { 'list': 'bullet' }],
                [{ 'indent': '-1'}, { 'indent': '+1' }],
                [{ 'color': [] }, { 'background': [] }],
                ['clean']
            ]
        }
    });

    //show an error or success message
    function showMessage(message, type = 'success') {
        
        const messageBox = document.createElement('div');
        messageBox.className = `flash ${type} client-message`;
        messageBox.textContent = message;
        
        const container = document.querySelector('.container');
        container.insertBefore(messageBox, container.firstChild);
        
        setTimeout(() => {
            messageBox.remove();
        }, 5000);
    }
    
    // --- Encryption/Decryption Handlers ---

    /**
     * Encrypts a string using the globally set masterKey.
     * @param {string} dataString The string to encrypt (title or content).
     * @returns {string} The serialized encrypted data (ciphertext, salt, iv).
     */
    function encryptData(dataString) {
        if (!masterKey) throw new Error("Encryption key is not set. Cannot encrypt.");
        
        // Use the masterKey (which is the result of key derivation from the password)
        const encrypted = CryptoJS.AES.encrypt(dataString, masterKey, {
            mode: CryptoJS.mode.CFB,
            padding: CryptoJS.pad.AnsiX923
        });
        
        // Serialize the result into a storable string format
        return encrypted.toString();
    }

    /**
     * Decrypts a string using the globally set masterKey.
     * @param {string} encryptedString The serialized encrypted data.
     * @returns {string} The decrypted plaintext string.
     */
    function decryptData(encryptedString) {
        if (!masterKey) throw new Error("Encryption key is not set. Cannot decrypt.");
        
        // Parse the serialized string back into a CipherParams object
        const decrypted = CryptoJS.AES.decrypt(encryptedString, masterKey, {
            mode: CryptoJS.mode.CFB,
            padding: CryptoJS.pad.AnsiX923
        });
        
        // Convert the Utf8-encoded WordArray back to a string
        return decrypted.toString(CryptoJS.enc.Utf8);
    }

    // --- CRUD API Functions ---

    /**
     * Fetches all entries from the server and decrypts them for display.
     */
    async function fetchEntries() {
        if (!masterKey) {
            console.warn("Attempted to fetch entries before master key was set.");
            return;
        }
        loadingSpinner.classList.remove('hidden');
        entryListElement.innerHTML = '';
        
        try {
            const response = await fetch('/api/entries');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            allEntries = data; // Store encrypted cache
            renderEntries();
        } catch (error) {
            showMessage('Failed to load entries. Check your network connection.', 'danger');
            console.error('Fetch Entries Error:', error);
        } finally {
            loadingSpinner.classList.add('hidden');
        }
    }

    /**
     * Saves a new or updates an existing entry.
     */
    async function saveEntry() {
        // CRITICAL CHECK: Ensure the encryption key is available
        if (!masterKey) {
            showMessage('Error: Encryption key is missing. Please re-enter your master password.', 'danger');
            console.error("Save failed: masterKey is null.");
            return;
        }

        const title = entryTitleInput.value.trim();
        const content = quill.root.innerHTML;

        // Basic validation
        if (!title || content.trim() === '<p><br></p>' || content.trim() === '') {
            showMessage('Title and content cannot be empty.', 'danger');
            return;
        }

        let encryptedTitle, encryptedContent;
        try {
            // 1. Encrypt data before sending
            encryptedTitle = encryptData(title);
            encryptedContent = encryptData(content);
        } catch (error) {
            showMessage('Failed to encrypt entries. Check console for details.', 'danger');
            console.error("Encryption Error:", error);
            return;
        }

        const payload = {
            encrypted_title: encryptedTitle,
            encrypted_content: encryptedContent
        };
        
        let url = '/api/entries';
        let method = 'POST';

        if (currentEntry && currentEntry.id) {
            // It's an update
            url = `/api/entries/${currentEntry.id}`;
            method = 'PUT';
        }

        try {
            const response = await fetch(url, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();
            showMessage(result.message || 'Entry saved successfully!');
            
            // After saving, reset editor and refresh list
            clearEditor();
            await fetchEntries(); 
        } catch (error) {
            showMessage('Failed to save entry. Check network or server logs.', 'danger');
            console.error('Save Entry API Error:', error);
        }
    }

    /**
     * Deletes the currently selected entry after confirmation.
     */
    function deleteCurrentEntry() {
        if (!currentEntry || !currentEntry.id) {
            showMessage('No entry selected to delete.', 'danger');
            return;
        }

        showConfirm('Confirm Deletion', 'Are you sure you want to permanently delete this diary entry? This action cannot be undone.', async () => {
            try {
                const response = await fetch(`/api/entries/${currentEntry.id}`, {
                    method: 'DELETE'
                });

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                showMessage('Entry deleted successfully.');
                clearEditor();
                await fetchEntries(); // Refresh the list
            } catch (error) {
                showMessage('Failed to delete entry.', 'danger');
                console.error('Delete Entry API Error:', error);
            }
        });
    }

    // --- UI/Rendering Handlers ---
    
    /**
     * Renders the list of entries, applying search filters if provided.
     * @param {string} filterText Optional text to filter titles and content.
     */
  function renderEntries(keyword = '', dateFilter = '') {
    entryListElement.innerHTML = ''; // Clear the current list
    const filter = keyword.toLowerCase(); // Case-insensitive search

    if (allEntries.length === 0) {
        entryListElement.innerHTML = '<p class="no-entries-msg">Start your diary by clicking "✍️ New Entry".</p>';
        return;
    }

    allEntries.forEach(encryptedEntry => {
        let decryptedTitle = 'Decryption Error';
        let decryptedSnippet = 'Error: Cannot decrypt entry content.';

        try {
            // Decrypt title and content
            decryptedTitle = decryptData(encryptedEntry.encrypted_title);
            const decryptedContent = decryptData(encryptedEntry.encrypted_content);

            // Create snippet without HTML tags
            decryptedSnippet = decryptedContent.replace(/<[^>]*>?/gm, '').substring(0, 50) + '...';

            // Convert entry date to YYYY-MM-DD format to match date input
            const entryDate = new Date(encryptedEntry.date_modified).toISOString().split('T')[0];

            // Keyword filter
            const matchesKeyword = !filter || 
                decryptedTitle.toLowerCase().includes(filter) || 
                decryptedContent.toLowerCase().includes(filter);

            // Date filter
            const matchesDate = !dateFilter || entryDate === dateFilter;

            // Skip entry if it doesn't match keyword or date
            if (!matchesKeyword || !matchesDate) {
                return;
            }

        } catch (error) {
            console.error("Decryption failed for entry ID", encryptedEntry.id, error);
        }

        // Create the entry HTML
        const listItem = document.createElement('div');
        listItem.className = 'entry-item';
        listItem.dataset.id = encryptedEntry.id;
        listItem.innerHTML = `
            <div class="entry-header-list">
                <h3 class="entry-title-list">${decryptedTitle}</h3>
                <small class="entry-date-list">${new Date(encryptedEntry.date_modified).toLocaleDateString()}</small>
            </div>
            <p class="entry-snippet">${decryptedSnippet}</p>
        `;

        // Click event to open the entry
        listItem.addEventListener('click', () => {
            editEntry(encryptedEntry);
            document.querySelectorAll('.entry-item').forEach(item => item.classList.remove('selected'));
            listItem.classList.add('selected');
        });

        entryListElement.appendChild(listItem);
    });

    // Show message if no entries match
    if (entryListElement.children.length === 0) {
        entryListElement.innerHTML = `<p class="no-entries-msg">No entries found for your search.</p>`;
    }
}


    
    /**
     * Loads the selected entry into the editor.
     * @param {object} encryptedEntry The raw encrypted entry object from the server.
     */
    function editEntry(encryptedEntry) {
        currentEntry = encryptedEntry;
        
        try {
            const decryptedTitle = decryptData(encryptedEntry.encrypted_title);
            const decryptedContent = decryptData(encryptedEntry.encrypted_content);

            entryTitleInput.value = decryptedTitle;
            quill.root.innerHTML = decryptedContent;
            
            entryEditorElement.classList.remove('hidden');
            deleteEntryBtn.classList.remove('hidden');
            saveEntryBtn.textContent = 'Save Changes';
            
            // Fix: Added null check for editorTitle
            const editorTitleElement = document.getElementById('editorTitle');
            if (editorTitleElement) {
                editorTitleElement.textContent = 'Edit Entry';
            }

        } catch (error) {
            showMessage('Failed to decrypt and load entry. You may have used a different password.', 'danger');
            console.error("Edit Entry Decryption Error:", error);
        }
    }

    /**
     * Resets the editor for a new entry.
     */
    function clearEditor() {
        currentEntry = null;
        entryTitleInput.value = '';
        quill.root.innerHTML = '';
        entryEditorElement.classList.remove('hidden');
        deleteEntryBtn.classList.add('hidden');
        saveEntryBtn.textContent = 'Create Entry';
        
        // Fix: Added null check for editorTitle
        const editorTitleElement = document.getElementById('editorTitle');
        if (editorTitleElement) {
            editorTitleElement.textContent = 'New Entry';
        }
        
        document.querySelectorAll('.entry-item').forEach(item => item.classList.remove('selected'));
    }

    // --- Modal Handlers ---

    /**
     * Prompts the user with a confirmation modal.
     * @param {string} title The modal title.
     * @param {string} message The confirmation message.
     * @param {function} onConfirm Callback function on 'Yes'.
     */
    function showConfirm(title, message, onConfirm) {
        confirmTitle.textContent = title;
        confirmMessage.textContent = message;
        confirmModal.classList.remove('hidden');

        // Clone and re-attach listeners to prevent multiple bindings
        const yesClone = confirmYesBtn.cloneNode(true);
        confirmYesBtn.parentNode.replaceChild(yesClone, confirmYesBtn);
        confirmYesBtn = yesClone;

        const noClone = confirmNoBtn.cloneNode(true);
        confirmNoBtn.parentNode.replaceChild(noClone, confirmNoBtn);
        confirmNoBtn = noClone;

        confirmYesBtn.onclick = () => {
            confirmModal.classList.add('hidden');
            onConfirm();
        };

        confirmNoBtn.onclick = () => {
            confirmModal.classList.add('hidden');
        };
    }
    
    // --- Event Listeners and Initialization ---

    setPasswordBtn.addEventListener('click', async () => {
        const password = masterPasswordInput.value;
        if (!password) {
            showMessage('Password cannot be empty.', 'danger');
            return;
        }

        try {
            
            masterKey = password;
            passwordModal.classList.add('hidden');
            await fetchEntries(); // Start application by fetching data

        } catch (error) {
            // This block is unlikely to be hit unless the browser's crypto API fails.
            showMessage('Failed to derive encryption key.', 'danger');
            console.error("Key Derivation Error:", error);
        }
    });

    newEntryBtn.addEventListener('click', clearEditor);
    saveEntryBtn.addEventListener('click', saveEntry);
    cancelEditBtn.addEventListener('click', () => {
        clearEditor();
        entryEditorElement.classList.add('hidden');
    });
    deleteEntryBtn.addEventListener('click', deleteCurrentEntry);

   // Search functionality
searchBtn.addEventListener('click', () => renderEntries(searchInput.value, dateInput.value));

searchInput.addEventListener('input', () => renderEntries(searchInput.value, dateInput.value));

searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        renderEntries(searchInput.value, dateInput.value);
    }
});

// Optional: Also trigger search when date changes
dateInput.addEventListener('change', () => renderEntries(searchInput.value, dateInput.value));

    /**
     * The main function to start the application flow.
     */
    function init() {
        // Find modal buttons since they might be dynamically replaced
        confirmYesBtn = document.getElementById('confirmYes');
        confirmNoBtn = document.getElementById('confirmNo');

        // Dynamically add the Logout button to the header controls
        const logoutButton = document.createElement('a');
        logoutButton.href = '/logout';
        logoutButton.className = 'new-entry-btn'; // Reusing the button styling
        logoutButton.style.background = 'linear-gradient(135deg, #f56565, #e53e3e)';
        logoutButton.style.marginLeft = '10px';
        logoutButton.textContent = '🚪 Logout';
        
        const headerControls = document.querySelector('.header-controls');
        headerControls.appendChild(logoutButton);

        // Hide the editor on startup
        entryEditorElement.classList.add('hidden');
        deleteEntryBtn.classList.add('hidden');

        // Display the password modal first to get the key before attempting to fetch/decrypt
        passwordModal.classList.remove('hidden');
    }
    
    init();
});