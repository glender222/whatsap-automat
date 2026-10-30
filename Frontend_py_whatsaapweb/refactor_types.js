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
    
    // Replace imports
    content = content.replace(/import\s+type\s+\{\s*([^}]+)\s*\}\s+from\s+['"](\.\.\/)*types\/(chatTypes|mediaTypes)['"];/g, (match, types) => {
      let newTypes = types
        .replace(/ChatInfo/g, 'WhatsAppChat')
        .replace(/MessageInfo/g, 'WhatsAppMessage')
        .replace(/MediaInfo/g, 'WhatsAppMedia');
        
      if (file.includes('hooks/')) {
        return `import type { ${newTypes} } from '../../../shared/types/wsp';`;
      } else if (file.includes('extras/') || file.includes('bandeja de chats/')) {
        return `import type { ${newTypes} } from '../../../../shared/types/wsp';`;
      } else if (file.includes('components/ChatContainer.tsx')) {
        return `import type { ${newTypes} } from '../../../shared/types/wsp';`;
      }
      return match; // Fallback
    });
    
    // Replace usages
    content = content.replace(/\bChatInfo\b/g, 'WhatsAppChat');
    content = content.replace(/\bMessageInfo\b/g, 'WhatsAppMessage');
    content = content.replace(/\bMediaInfo\b/g, 'WhatsAppMedia');
    
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('Updated ' + file);
  }
});
