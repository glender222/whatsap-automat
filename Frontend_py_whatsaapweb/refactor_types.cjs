const fs = require('fs');
const path = require('path');

const filesToUpdate = [
  'src/factures/mensajeria/components/bandeja de chats/ChatSidebar.tsx',
  'src/factures/mensajeria/hooks/useContactPanel.ts',
  'src/factures/mensajeria/hooks/useGalleryModal.ts',
  'src/factures/mensajeria/components/extras/ImageCarousel.tsx',
  'src/factures/mensajeria/components/extras/MediaViewer.tsx',
  'src/factures/mensajeria/hooks/useMessagesManagement.ts',
  'src/factures/mensajeria/components/extras/UserMediaPanel.tsx',
  'src/factures/mensajeria/components/extras/ImageGalleryModal.tsx',
  'src/factures/mensajeria/components/ChatContainer.tsx',
  'src/factures/mensajeria/components/bandeja de chats/ChatFilePreview.tsx',
  'src/factures/mensajeria/components/bandeja de chats/MessagesPanel.tsx',
  'src/factures/mensajeria/components/bandeja de chats/MediaPreview.tsx',
  'src/factures/mensajeria/hooks/useFileUpload.tsx',
  'src/factures/mensajeria/components/bandeja de chats/MessagesPanelLoader.tsx',
  'src/factures/mensajeria/components/bandeja de chats/FilePreviewCard.tsx',
  'src/jotai/slices/messagesAtoms.ts',
  'src/factures/setting/hooks/useSocketEvents.ts'
];

filesToUpdate.forEach(file => {
  const filePath = path.join(__dirname, file);
  if (fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Determine the correct relative path to shared/types/wsp
    let wspPath = '';
    if (file.includes('extras/') || file.includes('bandeja de chats/')) {
      wspPath = '../../../../shared/types/wsp';
    } else if (file.includes('hooks/') || file.includes('components/')) {
      wspPath = '../../../shared/types/wsp';
    } else if (file.includes('slices/') || file.includes('setting/')) {
      wspPath = '../../shared/types/wsp';
    }

    // Replace the import line
    content = content.replace(/import\s+type\s+\{[^}]+\}\s+from\s+['"]([^'"]+)['"];/g, (match, srcPath) => {
      if (srcPath.includes('chatTypes') || srcPath.includes('mediaTypes')) {
        const typesMatch = match.match(/\{([^}]+)\}/);
        if (typesMatch) {
          const newTypes = typesMatch[1]
            .replace(/ChatInfo/g, 'WhatsAppChat')
            .replace(/MessageInfo/g, 'WhatsAppMessage')
            .replace(/MediaInfo/g, 'WhatsAppMedia');
          return `import type { ${newTypes.trim()} } from '${wspPath}';`;
        }
      }
      return match;
    });
    
    // Replace all usages of the types
    content = content.replace(/\bChatInfo\b/g, 'WhatsAppChat');
    content = content.replace(/\bMessageInfo\b/g, 'WhatsAppMessage');
    content = content.replace(/\bMediaInfo\b/g, 'WhatsAppMedia');
    
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('Updated ' + file);
  }
});
