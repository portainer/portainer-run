/** @param {string} md */
export function mdToHtml(md) {
  let h = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  h = h.replace(/```[\w]*\n([\s\S]*?)```/g, '<pre>$1</pre>')
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  h = h.replace(/^#{1,3} (.+)$/gm, '<h3>$1</h3>')
  h = h.replace(/^[ \t]*[-*] (.+)$/gm, '<li>$1</li>')
  h = h.replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
  h = h.replace(/(<li>[\s\S]*?<\/li>)(\n<li>[\s\S]*?<\/li>)*/g, '<ul>$&</ul>')
  h = h.replace(/\n\n+/g, '</p><p>')
  h = '<p>' + h + '</p>'
  h = h.replace(/<p>(\s*<(?:h3|ul|pre|li))/g, '$1')
  h = h.replace(/(<\/(?:h3|ul|pre)>)\s*<\/p>/g, '$1')
  h = h.replace(/<p>\s*<\/p>/g, '')
  return h
}
