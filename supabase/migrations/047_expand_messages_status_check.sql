ALTER TABLE public.messages
DROP CONSTRAINT IF EXISTS messages_status_check;

ALTER TABLE public.messages
ADD CONSTRAINT messages_status_check
CHECK (
  status = ANY (
    ARRAY[
      'pending'::text,
      'sending'::text,
      'sent'::text,
      'delivered'::text,
      'read'::text,
      'replied'::text,
      'failed'::text
    ]
  )
);
